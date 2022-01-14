let escapeStringRegexp = require('escape-regex');

const Wappalyzer = require('wappalyzer-core');

const MongoClient = require('mongodb').MongoClient;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION_URLS = 'crawled_data_urls_v0';
const MONGO_COLLECTION_PAGES = 'crawled_data_pages_v0';
const URLS_PER_REQUEST = 750;

const config = require('config');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index';

const fs = require('fs');
let offset = undefined;

const categories = JSON.parse(
    fs.readFileSync('/app/node_modules/wappalyzer/categories.json')
)

let technologies = {};

var fail = 0;

//this will load from a.json to z.json (and _.json)
for (const index of Array(27).keys()) {
    const character = index ? String.fromCharCode(index + 96) : '_'

    technologies = {
        ...technologies,
        ...JSON.parse(
            fs.readFileSync(
                '/app/node_modules/wappalyzer/technologies/' + character + '.json'
            )
        ),
    }
}


Wappalyzer.setTechnologies(technologies);
Wappalyzer.setCategories(categories);

fs.readFile('/app/mongoOffset.txt', 'utf8',function (err, data) {
    offset = parseInt(data);

    fs.writeFile('/app/mongoOffset.txt', (offset + URLS_PER_REQUEST).toString(), 'utf8', async function (err, data) {
        await fetchAndAnalyze();
    });

});

async function addToElasticsearch(url, cms_name, cms_version, confidence) {
    await client.index({
        index: ELASTICSEARCH_INDEX,
        body: {
            url: url,
            cms_name: cms_name,
            cms_version: cms_version,
            cms_version_defined: !(cms_version === undefined || cms_version === ''),
            confidence: confidence
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
            .find(
                { url: /^((?!\/wp-json\/)(?!https?:\/\/mail\.).)*(?<!\.css)(?<!\.js)(?<!\.json)(?<!\.xml)(?<!\/feed\/)(?<!\.woff)(?<!\.woff2)(?<!xmlrpc\.php)(?<!\.ttf)(?<!\.thmx)(?<!\.ico)(?<!\.png)$/ },
                { projection: { url: 1, checks: 1, _id: 0}}
            )
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

                if(lastCheck.status_code in [301, 302]) {
                    return;
                }

                let hash = lastCheck.hash;
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

                        let jsCssRegex = "^" + escapeStringRegexp(url);

                        mongoDb.collection(MONGO_COLLECTION_URLS)
                            .find( { url: { $regex: jsCssRegex} },
                                { projection: { url: 1, checks: 1, _id: 0} }
                            )
                            .toArray(function (error, result) {
                                let scriptSrc = [];
                                let cssSrc = [];

                                result.forEach(function (document) {
                                    if(document.url.endsWith(".js")) {
                                        scriptSrc.push(document.url);
                                    } else if (document.url.endsWith(".css")) {
                                        cssSrc.push(document.url);
                                    }
                                });

                                try {
                                    let detections = Wappalyzer.analyze({
                                        url: url,
                                        headers: headers,
                                        scriptSrc: scriptSrc,
                                        //cookies: {awselb: ['']},
                                        html: page
                                    });

                                    let results = Wappalyzer.resolve(detections);

                                    for (const technology of results) {
                                        for (const category of technology.categories) {
                                            if (category.id === CMS_CATEGORY_ID) {
                                                //(technology);
                                                addToElasticsearch(
                                                    url,
                                                    technology.name,
                                                    technology.version,
                                                    technology.confidence
                                                ).catch(console.log);
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.log(++fail, url);
                                }
                            });
                    })
            }).then(() => process.exit(0));
    })
}


