const fs = require('fs');
const Wappalyzer = require('wappalyzer');
const path = require('path');
const Redis = require('ioredis');


const REDIS_KEY = 'wappalyzer-result';

const redis = new Redis({
    host: 'redis',
    port: 6379
});

const urls = [
    'https://www.fer.unizg.hr',
    'https://cijepise.zdravlje.hr/',    //wordpress
    'https://microblink.com/',          //ez platform
    'https://gsas.harvard.edu/',         //drupal
]

const wappalyzer = new Wappalyzer();
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
            console.log(website.url);
            await redis.rpush(REDIS_KEY, JSON.stringify(website.results));
        }

        //console.log(JSON.stringify(results, null, 2))


        fs.writeFile( //privremeno zbog testiranja
            './response.txt', 
            JSON.stringify(results, null, 2),
            function (error, data) {
            }
        );
    } catch (error) {
        console.error(error)
    }

    await wappalyzer.destroy()

    var empty = false;
    while(!empty) { //testiram pražnjenje queuea
        await redis.lpop(REDIS_KEY, function(err, res) {
            if (err) { console.log(err); }

            if (res !== null) {
                console.log(res.substr(10, 50));
            }
            else {
                empty = true;
            }
        })
    }

    console.log("done");
})();


