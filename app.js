const Wappalyzer = require('wappalyzer-core');

const MongoClient = require('mongodb').MongoClient;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION = 'urls';
const URLS_PER_REQUEST = 5;

const config = require('config');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index';

const fs = require('fs');
let offset = undefined;

const categories = JSON.parse(
    fs.readFileSync('./node_modules/wappalyzer/categories.json')
)

let technologies = {};

//this will load from a.json to z.json (and _.json)
for (const index of Array(27).keys()) {
    const character = index ? String.fromCharCode(index + 96) : '_'

    technologies = {
        ...technologies,
        ...JSON.parse(
            fs.readFileSync(
                './node_modules/wappalyzer/technologies/' + character + '.json'
            )
        ),
    }
}


Wappalyzer.setTechnologies(technologies);
Wappalyzer.setCategories(categories);

let results = Wappalyzer.analyze({
    url: 'https://example.github.io/',
    meta: {generator: ['WordPress']},
    headers: {server: ['Nginx']},
    scriptSrc: ['jquery-3.0.0.js'],
    cookies: {awselb: ['']},
    html: '<div ng-app="">'
});

console.log(results)
process.exit();

fs.readFile('mongoOffset.txt', 'utf8',function (err, data) {
    offset = parseInt(data);

    fs.writeFile('mongoOffset.txt', (offset + URLS_PER_REQUEST).toString(), 'utf8', function (err, data) {
        fetchAndAnalyze();
    });

});

async function addToElasticsearch(url, cms_name, cms_version) {
    console.log(url);
    console.log(cms_name);
    console.log(cms_version);

    await client.index({
        index: ELASTICSEARCH_INDEX,
        body: {
            url: url,
            cms_name: cms_name,
            cms_version: cms_version
        }
    })
}

async function fetchAndAnalyze() {
    const username = config.get('mongo.username');
    const password = config.get('mongo.password');
    let url = 'mongodb://' + username +':' + password + '@host.docker.internal/' + MONGO_DB + '?authSource=admin';

    await MongoClient.connect(url,
        function (err, db) {
        let mongoDb = db.db(MONGO_DB);

        mongoDb.collection(MONGO_COLLECTION)
            .find({}, { projection: { url: 1, _id: 0}}) //extract only domain name
            .limit(URLS_PER_REQUEST)
            .sort({_id: 1})
            .skip(offset)
            .toArray(async function (error, result) {

                //Wappalyzer
                try {
                    await wappalyzer.init()

                    let urls = result.map(el => el.url);
                    console.log(urls);

                    const results = (await Promise.all(
                        urls.map(async (url) => ({
                            url,
                            results: await wappalyzer.open(url).analyze()
                        }))
                    ))

                    for (const website of results) {
                        console.log(website);
                        for (const technology of website.results.technologies) {
                            for (const category of technology.categories) {
                                if (category.id === CMS_CATEGORY_ID) {
                                    addToElasticsearch(
                                        website.url,
                                        technology.name,
                                        technology.version
                                    ).catch(console.log);
                                }
                            }
                        }
                    }
                    await wappalyzer.destroy()
                } catch (error) {
                    console.error(error)
                }
            });

    })
}


