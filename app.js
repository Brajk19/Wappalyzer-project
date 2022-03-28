const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectId;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION_URLS = 'crawled_data_urls_v0';
const MONGO_COLLECTION_PAGES = 'crawled_data_pages_v0';
const URLS_PER_REQUEST = 1000;
const START_ID = '603a6c5139ec133a07a37e2a';

const HTMLParser = require('node-html-parser');

const config = require('config');

const Wappalyzer = require('wappalyzer-core');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const fs = require('fs');
let startId = undefined;

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index-new-structure-test';

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
                meta[name.toLowerCase()].push(content);
            } else {
                meta[name] = [content];
                meta[name.toLowerCase()] = [content];
            }
        }
    }

    return meta;
}

function extractScriptSrc(html, website) {
    const scriptTags = HTMLParser.parse(html).querySelectorAll('script');

    let scriptSrc = [];

    for (const tag of scriptTags) {
        let src = tag.getAttribute('src');

        if(src !== undefined) {
            if(src[0] === '/') {
                src = website + src;
            }

            scriptSrc.push(src);
        }
    }

    return scriptSrc;
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
            headers[key.toLowerCase()] = [headersRaw[key]];
        } else {
            headers[key] = headersRaw[key];
            headers[key.toLowerCase()] = headersRaw[key];
        }
    }

    return headers;
}

async function addToElasticsearch(url, cms_name, cms_version, confidence, timestamp) {
    url = url.trim();

    // sometimes there are two version of same website
    // e.g 'www.fer.hr' and 'www.fer.hr/'
    if(url[url.length - 1] === '/'){
        url = url.slice(0, -1);
    }

    try {
        const document = await client.get(
            {
                index: ELASTICSEARCH_INDEX,
                id: url
            }
        )

        let data = document.body['_source'];

        data['wappalyzer_checks'][timestamp] = {
            cms_name: cms_name,
            cms_version: cms_version,
            cms_version_defined: !(cms_version === undefined || cms_version === ''),
            confidence: confidence
        };

        if (timestamp > data['latest_timestamp']) {
            //updating latest data
            data['latest_timestamp'] = timestamp;
            data['latest_cms_name'] = cms_name;
            data['latest_cms_version'] = cms_version;
            data['latest_cms_version_defined'] = !(cms_version === undefined || cms_version === '');
        }

        // updating elasticsearch document
        await client.index({
            index: ELASTICSEARCH_INDEX,
            id: url,
            body: data
        });


    } catch (e) {
        if (e.statusCode === 404) {
            //adding entry
            await client.index({
                index: ELASTICSEARCH_INDEX,
                id: url,
                body: {
                    url: url,
                    wappalyzer_checks: {
                        timestamp: {
                            cms_name: cms_name,
                            cms_version: cms_version,
                            cms_version_defined: !(cms_version === undefined || cms_version === ''),
                            confidence: confidence
                        }
                    },
                    latest_timestamp: timestamp,
                    latest_cms_name: cms_name,
                    latest_cms_version: cms_version,
                    latest_cms_version_defined: !(cms_version === undefined || cms_version === '')
                }
            })
        }
    }
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
                // TODO implement iterating over checks to find last non analyzed

                if (checks === undefined || url === undefined || lastCheck === undefined) {
                    continue;
                }

                if (lastCheck.status_code !== undefined && lastCheck.status_code !== null) {
                    if(Number(lastCheck.status_code) >= 300) {
                        continue;
                    }
                }

                let timestamp = lastCheck.timestamp;
                let hash = lastCheck.hash;
                let headers = transformHeaders(lastCheck.headers);

                //fetch html source code using hash
                const doc = await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .findOne(
                            { hash: hash },
                            { projection: { page: 1, checks:1, _id: 0 } }
                        );

                if(doc === undefined || doc === null) {
                    continue;
                }

                let page = doc.page;

                let lastHtmlCheck = doc.checks[Object.keys(doc.checks).length - 1];

                let scriptSrc = [];
                let scriptHashes = [];
                let linkHashes = [];

                if(lastHtmlCheck.crawled_links !== undefined) {
                    scriptSrc = Object.keys(lastHtmlCheck.crawled_links.scripts);       //urls of js files
                    scriptHashes = Object.values(lastHtmlCheck.crawled_links.scripts);  //hash of document with js code
                    linkHashes = Object.values(lastHtmlCheck.crawled_links.links);      //hash of document with css code
                }

                let scripts = [];   //js source code
                let css = [];       //css source code

                //fetching js source code
                const jsFiles =
                    await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .find(
                            { hash: { $in: scriptHashes }},
                            { projection: { page: 1, _id: 0} })
                        .toArray();

                for(const file of jsFiles) {
                    scripts.push(file.page);
                }

                scriptSrc = scriptSrc.concat(extractScriptSrc(page, url)); // merging with scripts extracted from <script> tags
                scriptSrc = Array.from(new Set(scriptSrc)); // unique values

                //fetching css source code
                const cssFiles =
                    await mongoDb.collection(MONGO_COLLECTION_PAGES)
                        .find(
                            { hash: { $in: linkHashes }},
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
                        scriptSrc: scriptSrc,
                        scripts: scripts,
                        css: css,
                        meta: extractMeta(page),
                        html: page
                    });

                    let results = await Wappalyzer.resolve(detections);

                    //if detected technology is CMS, store data in elasticsearch
                    for (const technology of results) {
                        for (const category of technology.categories) {
                            if (category.id === CMS_CATEGORY_ID) {
                                await addToElasticsearch(
                                    url,
                                    technology.name,
                                    technology.version,
                                    technology.confidence,
                                    timestamp
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