const Wappalyzer = require('wappalyzer');
const wappalyzer = new Wappalyzer();

const mongoose = require('mongoose');

const { Client } = require('@elastic/elasticsearch')
const client = new Client({ node: 'http://elasticsearch:9200' })

const CMS_CATEGORY_ID = 1;
const ELASTICSEARCH_INDEX = 'wappalyzer-index';

const urls = [
    'https://www.fer.unizg.hr',
    'https://cijepise.zdravlje.hr/',    //wordpress
    'https://microblink.com/',          //ez platform
    'https://gsas.harvard.edu/',         //drupal
]

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

(async function (callbackfn, thisArg) {
    try {
        await wappalyzer.init()

        const results = (await Promise.all(
            urls.map(async (url) => ({
                url,
                results: await wappalyzer.open(url).analyze()
            }))
        ))

        for (const website of results) {
            for(const technology of website.results.technologies) {
                for(const category of  technology.categories) {
                    if(category.id === CMS_CATEGORY_ID) {
                        addToElasticsearch(
                            website.url,
                            technology.name,
                            technology.version
                        ).catch(console.log);
                    }
                }
            }
        }
    } catch (error) {
        console.error(error)
    }

    await wappalyzer.destroy()
})();


