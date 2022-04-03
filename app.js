const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectId;
const MONGO_DB = 'websecradar';
const MONGO_COLLECTION_URLS = 'crawled_data_urls_v0';
const MONGO_COLLECTION_PAGES = 'crawled_data_pages_v0';
const URLS_PER_REQUEST = 200;
const START_ID = '603a6c5139ec133a07a37e2a';

const HTMLParser = require('node-html-parser');

const config = require('config');

const Wappalyzer = require('wappalyzer-core');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const slugify = require('slugify')

const fs = require('fs');

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'websecradar-detection-wappalyzer';
const ELASTICSEARCH_BATCH_SIZE = 1000;

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

(async () => await fetchAndAnalyze() )();

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

let bulkData = [];
async function addToElasticsearch(url, cms_name, cms_version, confidence, timestamp, page_hash) {
    //TODO change timestamp with one for batch

    bulkData.push(
        {
            index: {
                _index: ELASTICSEARCH_INDEX
            }
        },
        {
            main_url: url,
            page_hash: page_hash,
            wappalyzer_timestamp: Number(timestamp),
            wappalyzer_rule: slugify(cms_name + " " + cms_version),
            cms_name: cms_name,
            cms_version: cms_version,
            cms_version_defined: !(cms_version === undefined || cms_version === ''),
            cms_confidence: confidence
        }
    );

    if(bulkData.length >= ELASTICSEARCH_BATCH_SIZE) {
        await pushToElasticsearch();
    }
}

async function pushToElasticsearch() {
    const { body: bulkResponse } = await client.bulk({ refresh: true, body: bulkData })
    bulkData = [];
}

async function fetchAndAnalyze() {
    const username = config.get('mongo.username');
    const password = config.get('mongo.password');
    let url = 'mongodb://' + username + ':' + password + '@host.docker.internal/' + MONGO_DB + '?authSource=admin';

    let startId = START_ID;
    let finished = false;

        await MongoClient.connect(url,
            async function (err, db) {
                let mongoDb = db.db(MONGO_DB);

                while (finished === false) {

                    // fetching urls from mongo
                    const urls = await mongoDb.collection(MONGO_COLLECTION_URLS)
                        .find(
                            {_id: {$gt: new ObjectId(startId)}},
                            {projection: {url: 1, checks: 1, _id: 1}} //fetch id, url and array checks
                        )
                        .limit(URLS_PER_REQUEST)
                        .sort({_id: 1})
                        .toArray();

                    if (urls.length === 0) {
                        // all documents have been processed
                        finished = true;
                    } else {
                        startId = urls[urls.length - 1]._id; // last (largest) processed ID
                    }

                    const urlRegex = /^(?!https?:\/\/mail\.).*(\.hr|\.com|\.net|\.org)\/?$/;

                    for (const document of urls) {
                        let url = document.url;

                        if (urlRegex.test(url) === false) {
                            // TODO one time map of all extensions
                            continue;
                        }

                        let checks = document.checks;
                        let lastCheck = checks[Object.keys(checks).length - 1];

                        if (checks === undefined || url === undefined || lastCheck === undefined) {
                            continue;
                        }

                        if (lastCheck.status_code !== undefined && lastCheck.status_code !== null) {
                            if (Number(lastCheck.status_code) >= 300) {
                                continue;
                            }
                        }

                        let timestamp = lastCheck.timestamp;
                        let hash = lastCheck.hash;
                        let headers = transformHeaders(lastCheck.headers);

                        //fetch html source code using hash
                        const doc = await mongoDb.collection(MONGO_COLLECTION_PAGES)
                            .findOne(
                                {hash: hash},
                                {projection: {page: 1, checks: 1, _id: 0}}
                            );

                        if (doc === undefined || doc === null) {
                            continue;
                        }

                        let page = doc.page;

                        let lastHtmlCheck = doc.checks[Object.keys(doc.checks).length - 1];

                        let scriptSrc = [];
                        let scriptHashes = [];
                        let linkHashes = [];

                        if (lastHtmlCheck.crawled_links !== undefined) {
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
                                    {hash: {$in: scriptHashes}},
                                    {projection: {page: 1, _id: 0}})
                                .toArray();

                        for (const file of jsFiles) {
                            scripts.push(file.page);
                        }

                        scriptSrc = scriptSrc.concat(extractScriptSrc(page, url)); // merging with scripts extracted from <script> tags
                        scriptSrc = Array.from(new Set(scriptSrc)); // unique values

                        //fetching css source code
                        const cssFiles =
                            await mongoDb.collection(MONGO_COLLECTION_PAGES)
                                .find(
                                    {hash: {$in: linkHashes}},
                                    {projection: {page: 1, _id: 0}})
                                .toArray();

                        for (const file of cssFiles) {
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
                                            timestamp,
                                            hash
                                        ).catch(console.log);
                                    }
                                }
                            }
                        } catch (e) {
                        }
                    }
                }
                await pushToElasticsearch();
                process.exit(0);
            }
        )
}