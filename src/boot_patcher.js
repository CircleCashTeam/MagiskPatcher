// boot_patcher.js
// Web Worker
importScripts(
    '/magiskboot.js'
);


function logi(msg) {
    self.postMessage({ type: "response", data: msg });
}

function loge(msg) {
    self.postMessage({ type: "error", data: msg });
}

function cprint(msg) {
    self.postMessage({ type: 'command', data: msg });
}

self.onmessage = async function (event) {

    async function getDownloadLink() {
        const apiurl = "https://api.github.com/repos/topjohnwu/Magisk/releases/latest";
        const response = await fetch(apiurl);

        if (!response.ok) {
            throw new Error('Network response not ok!');
        }

        const data = await response.json();
        const assets = data.assets;

        let downloadLink = "#";
        assets.forEach(asset => {
            if (asset.name.startsWith("Magisk") && asset.name.endsWith(".apk")) {
                downloadLink = asset.browser_download_url;
            }
        });
        return downloadLink;
    }

    //const dlink = await getDownloadLink();
    //logi("Get download link: " + dlink);

    // 创建 magiskboot 实例
    await magiskboot({
        noInitialRun: true,
        print: (msg) => cprint(msg),
        printErr: (msg) => cprint(msg),
        locateFile: (file) => '/magiskboot.wasm',
    }).then((Module) => {
        function setenv(key, value) {
            Module.ccall('setenv', 'number', ['string', 'string', 'number'], [key, value, 1]);
        }

        function getenv(key) {
            return Module.ccall('getenv', 'string', ['string'], [key])
        }

        setenv('KEEPVERITY', 'true');
        setenv('KEEPFORCEENCRYPT', 'true');

        Module.callMain(['cpio', 'ramdisk.cpio', 'patch']);
    }).catch(e => {
        loge(`Error: ${e}`);
    });

    self.postMessage({type:'done'});
};

