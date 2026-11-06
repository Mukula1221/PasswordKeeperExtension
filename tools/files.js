// 正式版 zip 要放哪些檔案。e2e 測試也只把這些檔案裝進瀏覽器，測的就是使用者拿到的東西。
// 擴充功能的程式都在 src/，新增的檔案放在那裡就會一起打包。src/ 以外多了要打包的檔案要加在這裡，漏了的話 node tools/check.js 會擋下來。
// _locales/ 一定要跟 manifest.json 在同一層，這是瀏覽器的規定。
module.exports = ['manifest.json', 'src', 'icons', '_locales', 'LICENSE'];
