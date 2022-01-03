const Wappalyzer = require('wappalyzer-core');

const MongoClient = require('mongodb').MongoClient;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION_URLS = 'crawled_data_urls_v0';
const MONGO_COLLECTION_PAGES = 'crawled_data_pages_v0';
const URLS_PER_REQUEST = 25000;

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

const invalidExtensions = ['js', 'css', 'json', 'xml'];
var fail = 0;

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

        mongoDb.collection(MONGO_COLLECTION_URLS)
            .find({}, { projection: { url: 1, checks: 1, _id: 0}})
            .limit(URLS_PER_REQUEST)
            .sort({_id: 1})
            .skip(offset)
            .forEach(function (document) {
                let checks = document.checks;
                let url = document.url;
                let lastCheck = checks[Object.keys(checks).length - 1];

                if(checks === undefined || url === undefined || lastCheck === undefined) {
                    return;
                }

                let hash = lastCheck.hash;
                let statusCode = lastCheck.status_code;
                let headers = lastCheck.headers;

                mongoDb.collection(MONGO_COLLECTION_PAGES)
                    .find({hash: hash}, { projection: { page: 1, _id: 0}})
                    .toArray(async function (error, result) {
                        if(result === undefined || result[0] === undefined) {
                            return;
                        }

                        let page = result[0].page;

                        if(page === undefined) {
                            return;
                        }

                        try {
                            let detections = Wappalyzer.analyze({
                                url: url,
                                headers: headers,
                                //scriptSrc: ['jquery-3.0.0.js'],
                                //cookies: {awselb: ['']},
                                html: page
                            });

                            let results = Wappalyzer.resolve(detections);

                            for (const technology of results) {
                                for (const category of technology.categories) {
                                    if (category.id === CMS_CATEGORY_ID) {
                                        console.log(technology);
                                        addToElasticsearch(
                                            url,
                                            technology.name,
                                            technology.version
                                        ).catch(console.log);
                                    }
                                }
                            }
                        } catch (e) {
                            console.log(++fail, url);
                        }
                    })
            });
    })
}


