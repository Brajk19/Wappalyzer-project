console.log("test");

const fs = require('fs');
const Wappalyzer = require('wappalyzer');
const path = require('path')


const urls = ['https://www.fer.unizg.hr']

const wappalyzer = new Wappalyzer();
(async function() {
    try {
        await wappalyzer.init()

        const results = await Promise.all(
            urls.map(async (url) => ({
                url,
                results: await wappalyzer.open(url).analyze()
            }))
        )

        console.log(JSON.stringify(results, null, 2))
    } catch (error) {
        console.error(error)
    }

    await wappalyzer.destroy()
})()