// ============================================================
//  ISS Cloud Sync — uploader
//  READ-ONLY on the shared folder. Pushes:
//    - <folder>/txs/*.json  -> completed tickets  (status 'complete')
//    - <folder>/pend/*.json -> trucks on site now (status 'open')
//  Idempotent via ext_id. When a truck leaves (its pend file is gone or
//  tombstoned), the matching 'open' row is deleted so the live count stays
//  accurate. The reconcile (read + delete) needs the Supabase SERVICE key,
//  entered in Settings and stored only on this PC.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const SB_URL = 'https://cslrbpptdcehxbljgvvm.supabase.co';
const SB_ANON = 'sb_publishable_b-DZiQOIQ3N4u3v7yYN0Ow_eKwj4nyp';
// The service key is entered once in Settings and stored only on this PC
// (never in the repo/GitHub). It enables the live on-site count.
let FOLDER = '', SITE = '', SERVICE = '';

function configure(folder, site, serviceKey){
  FOLDER  = String(folder || '').trim();
  SITE    = String(site   || '').trim();
  SERVICE = String(serviceKey || '').trim();
}
function ready(){ return !!(FOLDER && SITE); }
function key(){ return SERVICE || SB_ANON; }           // service key bypasses RLS (read/delete)

function isSyncArtifact(name){
  const n = String(name || '').toLowerCase();
  return n.includes('.sync-conflict-') || n.includes('~syncthing~')
      || n.includes('.tmp-') || n.endsWith('.tmp')
      || n.includes('-conflicted copy') || n.startsWith('.');
}
function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(_){ return null; } }

// Read a kind folder, returning [{ name, data }]
function readKindFiles(kind){
  const dir = path.join(FOLDER, kind);
  let files; try { files = fs.readdirSync(dir); } catch(_){ return []; }
  return files.filter(f => f.endsWith('.json') && !isSyncArtifact(f))
    .map(f => ({ name: f.replace(/\.json$/i,''), data: readJsonSafe(path.join(dir, f)) }))
    .filter(x => x.data);
}
// Completed tickets are tx-###.json in the ROOT of the shared folder.
function readTxFiles(){
  let files; try { files = fs.readdirSync(FOLDER); } catch(_){ return []; }
  return files.filter(f => /^tx-.*\.json$/i.test(f) && !isSyncArtifact(f))
    .map(f => ({ name: f.replace(/\.json$/i,''), data: readJsonSafe(path.join(FOLDER, f)) }))
    .filter(x => x.data);
}
function num(v){ const n = parseFloat(v); return isFinite(n) ? n : null; }

function mapTx(tx){
  if(!tx || tx._deleted || !tx.id) return null;
  const fw = num(tx.firstWeight), sw = num(tx.secondWeight);
  const tare = (fw!=null && sw!=null) ? Math.min(fw, sw) : null;
  return {
    ext_id: SITE + ':' + String(tx.id), ticket: String(tx.id),
    reg: tx.vehicleReg||null, customer: tx.customer||null, product: tx.product||null,
    transporter: tx.transporter||null, batch_no: tx.batchNo||null,
    supplier: tx.supplier||null, destination: tx.destination||null, driver: tx.driver||null,
    action: tx.direction||null, status: 'complete',
    net: num(tx.net), empty_weight: tare,
    time_in: tx.firstWeightTime||null, time_out: tx.secondWeightTime||tx.completedAt||null,
    site: SITE
  };
}
// pend file -> an "open" (on-site) row. ext_id uses the file name (reg@bridge).
function mapPend(name, p){
  if(!p || p._deleted) return null;
  return {
    ext_id: SITE + ':pend:' + name, ticket: p.id ? String(p.id) : null,
    reg: p.vehicleReg||null, customer: p.customer||null, product: p.product||null,
    action: p.direction||null, status: 'open',
    net: null, empty_weight: num(p.firstWeight),
    time_in: p.firstWeightTime||p.queuedAt||null, time_out: null,
    site: SITE
  };
}

function api(method, pathq, body, extraHeaders){
  return new Promise((resolve)=>{
    let u; try{ u = new URL(SB_URL + '/rest/v1/' + pathq); } catch(e){ return resolve({ ok:false, reason:e.message }); }
    const payload = body ? JSON.stringify(body) : null;
    const headers = Object.assign({
      'apikey': key(), 'Authorization': 'Bearer ' + key(), 'Content-Type':'application/json'
    }, extraHeaders||{});
    if(payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(u, { method, headers }, res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=> resolve({ ok: res.statusCode<300, status:res.statusCode, body:d }));
    });
    req.on('error', e => resolve({ ok:false, reason:e.message }));
    req.setTimeout(20000, ()=>{ req.destroy(); resolve({ ok:false, reason:'timeout' }); });
    if(payload) req.write(payload); req.end();
  });
}

async function upsert(rows){
  if(!rows.length) return { ok:true, count:0 };
  let pushed=0, err=null;
  for(let i=0;i<rows.length;i+=200){
    const r = await api('POST','transactions?on_conflict=ext_id', rows.slice(i,i+200),
      { 'Prefer':'resolution=merge-duplicates,return=minimal' });
    if(r.ok) pushed += Math.min(200, rows.length-i); else err = r.reason||('HTTP '+r.status);
  }
  return err ? { ok:false, reason:err, count:pushed } : { ok:true, count:pushed };
}

async function syncNow(){
  if(!ready()) return { ok:false, reason:'Set the shared folder and site first' };

  // 1) completed tickets
  const txRows = readTxFiles().map(x=>mapTx(x.data)).filter(Boolean);
  const txRes = await upsert(txRows);

  // 2) on-site trucks — needs the service key (read + delete reconcile)
  let onsite = 0, pendMsg = '';
  const pendFiles = readKindFiles('pend');
  const pendRows = pendFiles.map(x=>mapPend(x.name, x.data)).filter(Boolean);
  onsite = pendRows.length;
  if(SERVICE){
    await upsert(pendRows);
    const currentExt = new Set(pendRows.map(r=>r.ext_id));
    const sel = await api('GET',
      `transactions?select=ext_id&site=eq.${encodeURIComponent(SITE)}&status=eq.open`, null);
    if(sel.ok){
      let cloud=[]; try{ cloud=JSON.parse(sel.body||'[]'); }catch(_){}
      const stale = cloud.map(r=>r.ext_id).filter(e => e && e.includes(':pend:') && !currentExt.has(e));
      for(const e of stale){
        await api('DELETE', `transactions?ext_id=eq.${encodeURIComponent(e)}`, null, { 'Prefer':'return=minimal' });
      }
    } else { pendMsg = ' (on-site read failed — check service key)'; }
  } else {
    pendMsg = ' · on-site count needs the service key';
  }

  if(!txRes.ok) return { ok:false, reason:txRes.reason, count:txRes.count, onsite };
  return { ok:true, count:txRes.count, total:txRows.length, onsite, note: pendMsg };
}

module.exports = { configure, ready, syncNow, mapTx, mapPend };
