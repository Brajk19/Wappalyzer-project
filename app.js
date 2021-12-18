const Wappalyzer = require('wappalyzer');
const wappalyzer = new Wappalyzer();

const MongoClient = require('mongodb').MongoClient;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION = 'urls';


const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index';


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

(async function () {
    let url = 'mongodb://{USERNAME}:{PASSWORD}@host.docker.internal/' + MONGO_DB + '?authSource=admin';

    await MongoClient.connect(url,
        function (err, db) {
        let mongoDb = db.db(MONGO_DB);

        mongoDb.collection(MONGO_COLLECTION)
            .find({}, { projection: { url: 1, _id: 0}}) //extract only domain name
            .limit(1)//temporary
            .sort({_id: 1})
            .skip(0)//will be replace with variable
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
})();


