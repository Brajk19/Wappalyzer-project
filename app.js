const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectId;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION_URLS = 'crawled_data_urls_v0';
const MONGO_COLLECTION_PAGES = 'crawled_data_pages_v0';
const URLS_PER_REQUEST = 500;
const START_ID = '603a6c5139ec133a07a37e2a';

const HTMLParser = require('node-html-parser');
const escapeStringRegexp = require('escape-regex');

const config = require('config');

const Wappalyzer = require('wappalyzer-core');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const fs = require('fs');
let startId = undefined;

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index';

const categories = JSON.parse(
    fs.readFileSync('/app/node_modules/wappalyzer/categories.json')
)


let technologies = {}; // all techonologies wappalyzer can detect

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

//filter out all non CMS techonologies
for(const key of Object.keys(technologies)) {
    if(!technologies[key].cats.includes(1)){
        delete technologies[key];
    }
}

Wappalyzer.setTechnologies(technologies);
Wappalyzer.setCategories(categories);


//reading offset and starting the main function
fs.readFile('/app/lastProcessedObjectId.txt', 'utf8',async function (err, data) {
    startId = data;
    await fetchAndAnalyze();
});

function extractMeta(html) {
    //meta data needs to be parsed from html because Wappalyzer requires it as an object
    const metaTags = HTMLParser.parse(html).querySelectorAll('meta');

    let meta = {};
    for(const metaTag of metaTags) {
        const name = metaTag.getAttribute('name');
        const content = metaTag.getAttribute('content');

        if(name !== undefined && content !== undefined) {
            if(name in meta) {
                meta[name].push(content);
            } else {
                meta[name] = [content];
            }
        }
    }

    return meta;
}

function transformHeaders(headersRaw) {
    // Wappalyzer requires that all values inside object are in array

    let headers = {};

    if(headersRaw === undefined || headersRaw === null) {
        return headers;
    }

    for(const key of Object.keys(headersRaw)) {
        if(!Array.isArray(headersRaw[key])) {
            headers[key] = [headersRaw[key]];
        } else {
            headers[key] = headersRaw[key];
        }
    }

    return headers;
}

async function addToElasticsearch(url, cms_name, cms_version, confidence) {
    // first we check if there is already this url in elasticsearch and delete it if it exists
    const search = await client.search(
        {
            index: ELASTICSEARCH_INDEX,
            body: {
                query: {
                    multi_match : {
                        query: url,
                        fields: ['url'],
                        type: 'phrase'
                    }
                }
            }
        });

    for(const doc of search.body.hits.hits) { // there should be only one or zero, but it's looping just in case
        await client.delete({
            index: ELASTICSEARCH_INDEX,
            id: doc._id
        });
    }

    //adding entry
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
        async function (err, db) {
            let mongoDb = db.db(MONGO_DB);

            /*
                fetching urls from mongo
             */
            console.log(startId);
            const urls = await mongoDb.collection(MONGO_COLLECTION_URLS)
                .find(
                    { _id: { $gt: new ObjectId(startId) } },
                    { projection: { url: 1, checks: 1, _id: 1 } } //fetch id, url and array checks
                )
                .limit(URLS_PER_REQUEST)
                .sort({ _id: 1 })
                .toArray();

            if (urls.length === 0) {
                // all documents have been processed, going back to beginning
                startId = START_ID;
            } else {
                startId = urls[urls.length - 1]._id; // last (largest) processed ID
            }

            const urlRegex = /^(?!https?:\/\/mail\.).*(\.hr|\.com|\.net)\/?$/;
            for (const document of urls) {
                let url = document.url;

                if(urlRegex.test(url) === false) {
                    continue;
                }

                let checks = document.checks;
                let lastCheck = checks[Object.keys(checks).length - 1];

                if (checks === undefined || url === undefined || lastCheck === undefined) {
                    continue;
                }

                if (lastCheck.status_code !== undefined && lastCheck.status_code !== null) {
                    if(Number(lastCheck.status_code) >= 300) {
                        continue;
                    }
                }

                let hash = lastCheck.hash;
                let headers = transformHeaders(lastCheck.headers);

                //fetch html source code using hash
                const doc = await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .findOne({hash: hash}, {projection: {page: 1, _id: 0}});

                if(doc === undefined || doc === null) {
                    continue;
                }

                let page = doc.page;

                /*
                    this will fetch all pages for url
                    e.g. for "www.website.com" this will get
                    "www.website.com/help"
                    "www.website.com/file.js"
                    "www.website.com/file.css"
                 */
                let prefixRegex = "^" + escapeStringRegexp(url);
                const docs = await mongoDb.collection(MONGO_COLLECTION_URLS)
                    .find({ url: { $regex: prefixRegex } },
                        { projection: { url: 1, checks: 1, _id: 0 } }
                    )
                    .toArray();

                let scriptSrc = [];     //urls of js files
                let cssSrc = [];        //urls of css files
                let scripts = [];       //js source code
                let css = [];           //css source code


                //filter out js and css files
                for(const doc of docs) {
                    if(doc.url.endsWith(".js")) {
                        scriptSrc[doc.url] = doc.checks[Object.keys(doc.checks).length - 1].hash;
                    } else if(doc.url.endsWith(".css")) {
                        cssSrc.push(doc.checks[Object.keys(doc.checks).length - 1].hash);
                    }
                }

                //fetching js source code
                const jsFiles =
                    await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .find(
                            { hash: { $in: Object.values(scriptSrc) }},
                            { projection: { page: 1, _id: 0} })
                        .toArray();

                for(const file of jsFiles) {
                    scripts.push(file.page);
                }

                //fetching css source code
                const cssFiles =
                    await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .find(
                            { hash: { $in: Object.values(cssSrc) }},
                            { projection: { page: 1, _id: 0} })
                        .toArray();

                for(const file of cssFiles) {
                    css.push(file.page);
                }

                try {
                    // Wappalyzer analysis
                    const detections = Wappalyzer.analyze({
                        url: url,
                        headers: headers,
                        scriptSrc: Object.keys(scriptSrc),
                        scripts: scripts,
                        css: css,
                        meta: extractMeta(page),
                        html: page
                    });

                    let results = await Wappalyzer.resolve(detections);

                    /*
                        if detected technology is CMS, store data in elasticsearch
                        every result should be CMS, but to make sure id is checked
                     */
                    for (const technology of results) {
                        for (const category of technology.categories) {
                            if (category.id === CMS_CATEGORY_ID) {
                                await addToElasticsearch(
                                    url,
                                    technology.name,
                                    technology.version,
                                    technology.confidence
                                ).catch(console.log);
                            }
                        }
                    }
                } catch (e) {
                    console.log(url);
                    console.log(e);
                }
            }

            fs.writeFile('/app/lastProcessedObjectId.txt', startId.toString(), 'utf8', async function (err, data) {
                process.exit(0);
            });
        })
}