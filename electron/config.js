'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file(){ return path.join(app.getPath('userData'), 'iss-cloud-sync.json'); }

function load(){
  try { const c = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return Object.assign({ folder:'C:\\weighbridgeshare', site:'', serviceKey:'' }, c); }
  catch(_){ return { folder: 'C:\\weighbridgeshare', site: '', serviceKey: '' }; }
}
function save(cfg){
  try { fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(cfg, null, 2)); return true; }
  catch(e){ return false; }
}
module.exports = { load, save };
