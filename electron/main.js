'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const uploader = require('./uploader');
const config = require('./config');

let tray = null, win = null, cfg = { folder: 'C:\\weighbridgeshare', site: '' };
let lastStatus = { when: null, ok: null, count: 0, total: 0, msg: 'Not synced yet' };
let watchTimer = null, watcher = null;

// Only allow one copy to run — a second launch just focuses the existing one.
if(!app.requestSingleInstanceLock()){ app.quit(); }
app.on('second-instance', ()=>{ createWindow(); });

function applyConfig(){ uploader.configure(cfg.folder, cfg.site); }

async function doSync(reason){
  if(!uploader.ready()){ lastStatus = { when:new Date(), ok:false, count:0, total:0, msg:'Set folder + site' }; pushStatus(); return; }
  const r = await uploader.syncNow();
  lastStatus = {
    when: new Date(), ok: r.ok, count: r.count||0, total: r.total||0,
    msg: r.ok ? `Synced ${r.count} tickets · ${r.onsite||0} on site${r.note||''}` : ('Error: ' + (r.reason||'unknown'))
  };
  updateTrayTip(); pushStatus();
}

function pushStatus(){ if(win && !win.isDestroyed()) win.webContents.send('status', publicStatus()); }
function publicStatus(){
  return {
    folder: cfg.folder, site: cfg.site,
    when: lastStatus.when ? lastStatus.when.toLocaleTimeString() : '—',
    ok: lastStatus.ok, msg: lastStatus.msg
  };
}
function updateTrayTip(){
  if(tray) tray.setToolTip('ISS Cloud Sync — ' + (cfg.site||'no site') + ' — ' + lastStatus.msg);
}

function startWatching(){
  if(watchTimer) clearInterval(watchTimer);
  if(watcher){ try{ watcher.close(); }catch(_){} watcher=null; }
  applyConfig();
  // poll every 30s (reliable across network/Syncthing folders)
  watchTimer = setInterval(()=>doSync('interval'), 30000);
  // also react to changes in the txs folder if it exists
  try{
    const txsDir = path.join(cfg.folder, 'txs');
    if(fs.existsSync(txsDir)){
      let deb=null;
      watcher = fs.watch(txsDir, ()=>{ clearTimeout(deb); deb=setTimeout(()=>doSync('watch'), 2500); });
    }
  }catch(_){}
  doSync('start');
}

function createWindow(){
  if(win && !win.isDestroyed()){ win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 460, height: 430, resizable: false, fullscreenable: false,
    title: 'ISS Cloud Sync', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', ()=>{ win = null; });
  win.webContents.on('did-finish-load', pushStatus);
}

function buildTray(){
  let img;
  try{ img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({width:16,height:16}); }
  catch(_){ img = nativeImage.createEmpty(); }
  tray = new Tray(img);
  tray.setToolTip('ISS Cloud Sync');
  const menu = Menu.buildFromTemplate([
    { label: 'Open ISS Cloud Sync', click: createWindow },
    { label: 'Sync now', click: ()=>doSync('menu') },
    { type: 'separator' },
    { label: 'Quit', click: ()=>{ app.isQuitting=true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', createWindow);
  updateTrayTip();
}

app.whenReady().then(()=>{
  cfg = config.load();

  // Auto-start on Windows login, launched hidden (tray only)
  try{
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }catch(_){}

  buildTray();
  startWatching();

  // Show the settings window on first run (no site set yet); otherwise stay in tray
  const launchedHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if(!cfg.site || !launchedHidden) createWindow();

  ipcMain.handle('get-config', ()=>publicStatus());
  ipcMain.handle('pick-folder', async ()=>{
    const r = await dialog.showOpenDialog(win, { properties:['openDirectory'], title:'Select the weighbridge shared folder' });
    if(!r.canceled && r.filePaths[0]){ cfg.folder = r.filePaths[0]; config.save(cfg); startWatching(); }
    return publicStatus();
  });
  ipcMain.handle('set-site', (_e, site)=>{ cfg.site = String(site||'').trim(); config.save(cfg); startWatching(); return publicStatus(); });
  ipcMain.handle('set-folder', (_e, folder)=>{ cfg.folder = String(folder||'').trim(); config.save(cfg); startWatching(); return publicStatus(); });
  ipcMain.handle('sync-now', async ()=>{ await doSync('button'); return publicStatus(); });
});

// Keep running in the tray when the window closes
app.on('window-all-closed', (e)=>{ /* stay alive in tray */ });
app.on('before-quit', ()=>{ if(watcher){ try{watcher.close();}catch(_){}} if(watchTimer) clearInterval(watchTimer); });
