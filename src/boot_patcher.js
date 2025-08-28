// boot_patcher.js
// Web Worker
importScripts("/MagiskPatcher/magiskboot.js");

function logi(msg) {
  self.postMessage({ type: "response", data: msg });
}

function loge(msg) {
  self.postMessage({ type: "error", data: msg });
}

function cprint(msg) {
  self.postMessage({ type: "command", data: msg });
}

self.onmessage = async function (event) {
  const { bootBuffer, needed, metadata } = event.data;

  console.log("Worker with options:", metadata);

  let TMP = "";
  // 创建 magiskboot 实例
  const Module = await magiskboot({
    noInitialRun: true,
    // Limit: I cant directly replace Module.print to get stdout...
    //        So I can only replace this dumbass method to set stdout to a tmp variable
    //print: (msg) => cprint(msg),
    print: (msg) => {
      //cprint(msg);
      TMP = msg.trim();
    },
    printErr: (msg) => cprint(msg),
    locateFile: (file) => "/MagiskPatcher/magiskboot.wasm",
  });

  function setenv(key, value) {
    Module.ccall(
      "setenv",
      "number",
      ["string", "string", "number"],
      [key, value, 1]
    );
  }

  function getenv(key) {
    return Module.ccall("getenv", "string", ["string"], [key]);
  }

  function isExist(path) {
    const stat = Module.FS.analyzePath(path, false);
    return stat.exists;
  }

  function copyFile(dest, orig) {
    if (isExist(orig)) {
      const data = Module.FS.readFile(orig);
      Module.FS.writeFile(dest, data);
    }
  }

  function grepProp(data, key) {
    for (const line of data.split('\n')) {
      if (line.includes('=')) {
        const [k, v] = line.trim().split('=');
        if (k === key) {
          return v;
        }
      }
    }
    return "";
  }

  for (const k in metadata.env) {
    logi(`セットアップ環境キー: ${k} value: ${metadata.env[k]}`);
    setenv(k.toString(), metadata.env[k]);
  }

  const userDir = "/home/web_user";
  logi("Chdir: " + userDir);
  Module.FS.chdir(userDir);

  // Write needed files!
  logi(`boot イメージを emscripiten FS を書き込み: ${userDir}/boot.img`);
  Module.FS.writeFile(`${userDir}/boot.img`, new Uint8Array(bootBuffer));
  for (const need in needed) {
    logi(`emscripten FS にファイルを書き込み: ${need} -> ${userDir}/${need}`);
    const data = new Uint8Array(needed[need]);
    Module.FS.writeFile(`${userDir}/${need}`, data);
  }

  let result = 0;
  logi("- boot イメージをアンパッキング中");
  result = Module.callMain(["unpack", "boot.img"]);
  switch (result) {
    case 0:
      break;
    case 1:
      loge("! 非対応/不明な boot イメージの形式です");
      break;
    case 2:
      loge("! ChromeOS の boot イメージはウェブに対応していません");
      break;
    default:
      loge("! boot イメージを展開できません");
      break;
  }

  // Preinit device not impl on web yet

  logi("- ramdisk の状態を確認中");
  let STATUS = 0;
  let SKIP_BACKUP = "";
  if (isExist("ramdisk.cpio")) {
    STATUS = Module.callMain(["cpio", "ramdisk.cpio", "test"]);
    SKIP_BACKUP = "";
  } else {
    STATUS = 0;
    SKIP_BACKUP = "#";
  }

  let SHA1 = "";
  switch (STATUS) {
    case 0:
      logi("- ストック boot イメージを検出しました");
      Module.callMain(["sha1", "boot.img"]);
      SHA1 = TMP; // stdout stored at TMP
      copyFile(`${userDir}/ramdisk.cpio.orig`, `${userDir}/ramdisk.cpio`);
      break;
    case 1:
      logi("- Magisk パッチ済みの boot イメージを検出しました");
      Module.callMain([
        "cpio",
        "ramdisk.cpio",
        "extract .backup/.magisk config.orig",
        "restore",
      ]);
      copyFile(`${userDir}/ramdisk.cpio.orig`, `${userDir}/ramdisk.cpio`);
      break;
    case 2:
      logi("! サポートされていないプログラムによってパッチされた boot イメージです");
      loge("! ストック boot イメージに戻してください");
      break;
  }

  if (isExist("config.orig")) {
    Module.FS.chmod("config.orig", 0o644); // This maybe not need
    const config = Module.FS.readFile("config.orig", { encoding: "utf8" });
    console.log("Get config from FS:", config)
    SHA1 = grepProp(config, "SHA1");
    console.log("SHA1 from origin config:", SHA1);
    Module.FS.unlink("config.orig");
  }

  logi("- ramdisk をパッチ中");
  let cpio_command_add = [];
  for (const f of ["magisk", "magisk32", "magisk64", "stub.apk", "init-ld"]) {
    const cf = (typeof f === 'string' && f.trim() === "stub.apk") 
      ? "stub.xz" 
      : `${f}.xz`;
    console.log("Try compress", f, "->", cf);
    if (isExist(f)) {
      logi(`${f} を xz に圧縮...`);
      Module.callMain(["compress=xz", f, cf]);
      cpio_command_add.push(`add 0644 overlay.d/sbin/${cf} ${cf}`);
    }
  }

  console.log("SHA1:", SHA1);
  // Write file config
  let config = "";
  config += `KEEPVERITY=${metadata.env.KEEPVERITY}\n`;
  config += `KEEPFORCEENCRYPT=${metadata.env.KEEPFORCEENCRYPT}\n`;
  config += `RECOVERYMODE=${metadata.env.RECOVERYMODE}\n`;
  if (SHA1.length != 0) {
    config += `SHA1=${SHA1}\n`;
  }
  console.log("Generated magisk config", config);
  Module.FS.writeFile(`${userDir}/config`, config, { encoding: "utf8" });

  result = Module.callMain([
    "cpio",
    "ramdisk.cpio",
    "add 0750 init magiskinit",
    "mkdir 0750 overlay.d",
    "mkdir 0750 overlay.d/sbin",
    ...cpio_command_add,
    "patch",
    `${SKIP_BACKUP} backup ramdisk.cpio.orig`,
    "mkdir 000 .backup",
    "add 000 .backup/.magisk config",
  ]);
  if (result != 0) {
    loge("! Unable to patch ramdisk");
  }

  for (const dt of ["dtb", "kernel_dtb", "extra"]) {
    if (isExist(`${userDir}/${dt}`)) {
      if (Module.callMain(["dtb", dt, "test"]) != 0) {
        logi(`! Boot イメージ ${dt} は古い Magisk (非対応) によってパッチが適用されています`);
        loge("! *パッチ未適用* の boot イメージで再度お試しください");
      }
      if (Module.callMain(["dtb", dt, "patch"]) == 0) {
        logi(`- boot イメージ ${dt} の fstab にパッチを適用します`);
      }
    }
  }

  if (isExist(`${userDir}/kernel`)) {
    let PATCHEDKERNEL = false;
    if (
      Module.callMain([
        "hexpatch",
        "kernel",
        "49010054011440B93FA00F71E9000054010840B93FA00F7189000054001840B91FA00F7188010054",
        "A1020054011440B93FA00F7140020054010840B93FA00F71E0010054001840B91FA00F7181010054",
      ]) == 0
    ) {
      PATCHEDKERNEL = true;
    }

    if (
      Module.callMain([
        "hexpatch",
        "kernel",
        "821B8012",
        "E2FF8F12",
      ]) == 0
    ) {
      PATCHEDKERNEL = true;
    }

    if (
      Module.callMain([
        "hexpatch",
        "kernel",
        "70726F63615F636F6E66696700",
        "70726F63615F6D616769736B00",
      ]) == 0
    ) {
      PATCHEDKERNEL = true;
    }

    if (metadata.env.LEGACYSAR == 'true') {
      if (
        Module.callMain([
          "hexpatch",
          "kernel",
          "736B69705F696E697472616D667300",
          "77616E745F696E697472616D667300",
        ]) == 0
      ) {
        PATCHEDKERNEL = true;
      }
    }

    if (!PATCHEDKERNEL) {
      Module.FS.unlink(`${userDir}/kernel`);
    }
  }

  result = Module.callMain(['repack', 'boot.img']);
  if (result != 0) {
    loge("! boot イメージを再パックできません");
  }

  const data = Module.FS.readFile(`${userDir}/new-boot.img`);

  this.postMessage({ type: "done", data: data});
};

