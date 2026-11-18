import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

let sequence = 0;
class Metadata {
  constructor(key,value,owner){this.key=key;this.value=value;this.owner=owner;}
  getKey(){return this.key;}
  getValue(){return this.value;}
  setValue(v){this.value=v;}
  remove(){this.owner.splice(this.owner.indexOf(this),1);}
}
class Range {
  constructor(sheet,startRow,startCol,height=1,width=1,rowOnly=false){Object.assign(this,{sheet,startRow,startCol,height,width,rowOnly});}
  getDeveloperMetadata(){return this.sheet.rowMeta.get(this.startRow)??[];}
  addDeveloperMetadata(key,value){const arr=this.sheet.rowMeta.get(this.startRow)??[];arr.push(new Metadata(key,value,arr));this.sheet.rowMeta.set(this.startRow,arr);return this;}
  getDisplayValues(){return this.getValues().map(row=>row.map(v=>v==null?'':String(v)));}
  getValues(){const out=[];for(let r=0;r<this.height;r++){const row=[];for(let c=0;c<this.width;c++){row.push(this.sheet.rows[this.startRow+r-1]?.[this.startCol+c-1]??'');}out.push(row);}return out;}
  setValues(rows){if(rows.length!==this.height||rows.some(row=>row.length!==this.width))throw Error('columns mismatch');for(let r=0;r<this.height;r++){const target=this.startRow+r-1;while(this.sheet.rows.length<=target)this.sheet.rows.push([]);for(let c=0;c<this.width;c++)this.sheet.rows[target][this.startCol+c-1]=rows[r][c];}return this;}
  setValue(v){return this.setValues([[v]]);}
  getValue(){return this.getValues()[0][0];}
  getDisplayValue(){return this.getDisplayValues()[0][0];}
  setNumberFormat(){return this;}
  setBackground(){return this;}
  setFontColor(){return this;}
  setFontWeight(){return this;}
}
class Sheet {
  constructor(name){this.name=name;this.rows=[];this.rowMeta=new Map();this.id=++sequence;this.columns=26;this.maxRows=100;}
  getName(){return this.name;}
  getSheetId(){return this.id;}
  getMaxRows(){return this.maxRows;}
  getMaxColumns(){return this.columns;}
  insertColumnsAfter(_,count){this.columns+=count;}
  insertRowsAfter(_,count){this.maxRows+=count;}
  getLastRow(){for(let i=this.rows.length-1;i>=0;i--)if(this.rows[i].some(x=>x!==''&&x!=null))return i+1;return 0;}
  getRange(...args){if(typeof args[0]==='string'){const number=Number(args[0].split(':')[0]);return new Range(this,number,1,1,this.columns,true)}return new Range(this,...args);}
  deleteRow(row){this.rows.splice(row-1,1);const map=new Map();for(const [id,values] of this.rowMeta){if(id===row)continue;map.set(id>row?id-1:id,values);}this.rowMeta=map;}
  setFrozenRows(){}
  setColumnWidth(){}
}
class Spreadsheet {
  constructor(){this.sheets=[];this.metadata=[];this.zone='UTC';}
  getSheets(){return this.sheets;}
  getSheetByName(name){return this.sheets.find(item=>item.name===name);}
  insertSheet(name){const sheet=new Sheet(name);this.sheets.push(sheet);return sheet;}
  getDeveloperMetadata(){return this.metadata;}
  addDeveloperMetadata(key,value){this.metadata.push(new Metadata(key,value,this.metadata));}
  getSpreadsheetTimeZone(){return this.zone;}
}

const spreadsheet=new Spreadsheet();
const Utilities={
  getUuid:()=>`server-${++sequence}`,
  formatDate(d,_zone,format){const iso=new Date(d).toISOString();return format==='yyyy-MM-dd'?iso.slice(0,10):iso.slice(11,19);},
  parseDate(text,_zone,_pattern){return new Date(text.replace(' ','T')+'Z');},
};
const context=vm.createContext({console,Utilities,SpreadsheetApp:{}});
vm.runInContext(await fs.readFile(new URL('../google-apps-script/Code.gs',import.meta.url),'utf8'),context);
const syncData=(body)=>vm.runInContext('syncData',context)(spreadsheet,body);
const base={deletedEntryIds:[],deletedProjects:[]};

test('v4 uploads six visible fields, calculates hours, and reads them back',()=>{
  const body={...base,projects:[{id:'p1',name:'DeStyle',syncStatus:'pending'}],entries:[{
    id:'e1',sessionId:'s1',projectId:'p1',projectName:'DeStyle',date:'2026-11-12',
    startedAt:'2026-11-12T10:00:00.000Z',endedAt:'2026-11-12T10:30:00.000Z',
    durationMs:1800000,timeZone:'UTC',taskDescription:'Макет главной',
  }]};
  const result=syncData(body);
  assert.equal(result.uploaded,1);
  assert.equal(result.createdTabs,1);
  assert.equal(result.entries[0].taskDescription,'Макет главной');
  const sheet=spreadsheet.getSheetByName('12.11.2026');
  assert.equal(sheet.rows[0].length,6);
  assert.deepEqual(sheet.rows[1],['DeStyle','10:00:00','10:30:00','00:30:00',0.5,'Макет главной']);
});

test('v4 updates description and duration edited manually in Sheets',()=>{
  const sheet=spreadsheet.getSheetByName('12.11.2026');
  sheet.rows[1][3]='00:45:00';
  sheet.rows[1][5]='Новая задача';
  const result=syncData({...base,projects:[{id:'p1',name:'DeStyle',syncStatus:'synced'}],entries:[]});
  assert.equal(result.entries[0].durationMs,2700000);
  assert.equal(result.entries[0].taskDescription,'Новая задача');
  assert.equal(sheet.rows[1][4],0.75);
  assert.equal(result.uploaded,0);
});

test('v4 renames by project ID and retains entry ID',()=>{
  const result=syncData({...base,projects:[{id:'p1',name:'DeStyle 2',previousName:'DeStyle',syncStatus:'pending'}],entries:[]});
  const sheet=spreadsheet.getSheetByName('12.11.2026');
  assert.equal(sheet.rows[1][0],'DeStyle 2');
  assert.equal(result.entries[0].id,'e1');
  assert.equal(result.projects[0].name,'DeStyle 2');
});

test('v4 deletes a project and all its spreadsheet rows',()=>{
  const result=syncData({...base,projects:[],entries:[],deletedProjects:[{id:'p1',name:'DeStyle 2'}]});
  assert.equal(result.deletedProjectIds[0],'p1');
  assert.equal(result.projects.length,0);
  assert.equal(result.entries.length,0);
  assert.equal(spreadsheet.getSheetByName('12.11.2026').getLastRow(),1);
});

test('v4 upgrades existing v3 four-column date tab without losing session metadata',()=>{
  const sheet=spreadsheet.insertSheet('11.11.2026');
  sheet.rows=[
    ['Проект','Начало','Конец','Длительность'],
    ['Legacy','09:00:00','09:30:00','00:30:00'],
  ];
  const arr=[];
  arr.push(new Metadata('TRACKER_ENTRY_V3',JSON.stringify({
    id:'legacy-entry',sessionId:'legacy-session',projectId:'legacy-project',
    date:'2026-11-11',timeZone:'UTC',taskDescription:'',
    startedAt:'2026-11-11T09:00:00.000Z',endedAt:'2026-11-11T09:30:00.000Z',durationMs:1800000,
  }),arr));
  sheet.rowMeta.set(2,arr);
  const result=syncData({...base,projects:[{id:'legacy-project',name:'Legacy',syncStatus:'synced'}],entries:[]});
  assert.equal(sheet.rows[0].length,6);
  assert.equal(sheet.rows[1][4],0.5);
  assert.equal(result.entries.find(e=>e.id==='legacy-entry').sessionId,'legacy-session');
});

test('metadata keeps a long task description without duplicating it', () => {
  const taskDescription = 'З'.repeat(500);
  const result = syncData({ ...base, projects:[{id:'p2',name:'LongProject',syncStatus:'pending'}], entries:[{
    id:'short-id',sessionId:'short-session',projectId:'p2',projectName:'LongProject',
    date:'2026-11-13',startedAt:'2026-11-13T09:00:00Z',endedAt:'2026-11-13T09:30:00Z',
    durationMs:1800000,timeZone:'UTC',taskDescription,
  }] });
  const sheet = spreadsheet.getSheetByName('13.11.2026');
  const rowMeta = sheet.rowMeta.get(2).at(0).getValue();
  assert.equal(result.entries.find(e=>e.id==='short-id').taskDescription,taskDescription);
  assert.equal(JSON.parse(rowMeta).snapshotV4Hash.length>5,true);
  assert.equal(JSON.parse(rowMeta).snapshotV4,undefined);
  assert.equal(rowMeta.length<1024,true);
});

test('deleting a project preserves a sheet row manually reassigned to another project', () => {
  const body = {...base, projects: [
    {id:'audit-a', name:'Audit Project A', syncStatus:'pending'},
    {id:'audit-b', name:'Audit Project B', syncStatus:'pending'},
  ], entries:[{
    id:'audit-entry', sessionId:'audit-session', projectId:'audit-a',
    projectName:'Audit Project A', date:'2026-11-20',
    startedAt:'2026-11-20T09:00:00.000Z', endedAt:'2026-11-20T09:30:00.000Z',
    durationMs:1800000, timeZone:'UTC', taskDescription:'Перенос задачи',
  }]};
  assert.equal(syncData(body).uploaded, 1);
  const sheet=spreadsheet.getSheetByName('20.11.2026');
  sheet.rows[1][0]='Audit Project B'; // user reassigns the row in Sheets
  const result=syncData({...base, projects:[{id:'audit-b',name:'Audit Project B',syncStatus:'synced'}], entries:[], deletedProjects:[{id:'audit-a',name:'Audit Project A'}]});
  assert.equal(sheet.getLastRow(),2,'Reassigned row must not be deleted');
  assert.equal(sheet.rows[1][0],'Audit Project B');
  assert.equal(result.entries.find(entry=>entry.id==='audit-entry').projectId,'audit-b');
  assert.ok(result.projects.some(p=>p.id==='audit-b'));
  assert.ok(!result.projects.some(p=>p.id==='audit-a'));
});

test('deletion refuses to remove a different project that reused an old name', () => {
  syncData({...base, projects:[{id:'obsolete-id',name:'Reused Name',syncStatus:'pending'}], entries:[]});
  syncData({...base, projects:[],entries:[],deletedProjects:[{id:'obsolete-id',name:'Reused Name'}]});
  syncData({...base, projects:[{id:'new-owner-id',name:'Reused Name',syncStatus:'pending'}], entries:[]});
  assert.throws(() => syncData({...base, projects:[],entries:[],deletedProjects:[
    {id:'obsolete-id',remoteProjectId:'obsolete-id',name:'Reused Name'},
  ]}), /ID проекта в таблице не совпадает/);
  assert.equal(spreadsheet.getDeveloperMetadata().filter(m=>m.getKey()==='TRACKER_PROJECT_V3').length>0,true);
});

// In-process integration test: the actual extension sync module talks to the
// same mocked Apps Script runtime used by the server tests above.
test('extension v4 syncs rename, project deletion, and entry deletion end to end', async () => {
  let localState = {
    dateTabsMigrationV3: true,
    deletedEntryIds: [], deletedProjects: [],
    projects: [
      {id:'end-to-end-a',name:'End To End A',status:'idle',syncStatus:'pending',updatedAt:'2026-11-14T10:00:00.000Z'},
      {id:'end-to-end-b',name:'End To End B',status:'idle',syncStatus:'pending',updatedAt:'2026-11-14T10:00:00.000Z'},
    ],
    timeEntries: [{
      id:'end-to-end-entry',sessionId:'end-to-end-session',projectId:'end-to-end-a',projectName:'End To End A',
      date:'2026-11-21',startedAt:'2026-11-21T13:00:00.000Z',endedAt:'2026-11-21T13:30:00.000Z',
      durationMs:1800000,timeZone:'UTC',taskDescription:'Описание задачи',syncStatus:'pending',
    }],
  };
  globalThis.chrome={storage:{local:{
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(localState[k])]));},
    async set(value){localState={...localState,...structuredClone(value)};},
  }}};
  globalThis.__fakeAxios={post:async(_url,json)=>({data:{ok:true,version:'4.0.0',...syncData(JSON.parse(json))}})};
  const raw = await fs.readFile(new URL('../src/features/google-sheets/api/googleSheetsApi.js',import.meta.url),'utf8');
  const source=raw
    .replace("import axios from 'axios';",'const axios = globalThis.__fakeAxios;')
    .replaceAll('import.meta.env.VITE_WEB_APP_URL',JSON.stringify('https://script.google.com/macros/s/deployment/exec'))
    .replaceAll('import.meta.env.VITE_SYNC_SECRET',JSON.stringify('private-test-secret'));
  const api=await import(`data:text/javascript,${encodeURIComponent(source)}`);

  const first=await api.syncTimeEntries();
  assert.equal(first.uploaded,1);
  assert.equal(localState.projects.filter(p=>p.id.startsWith('end-to-end-')).length,2);
  assert.equal(localState.timeEntries.find(e=>e.id==='end-to-end-entry').syncStatus,'synced');

  localState.projects=localState.projects.map(p=>p.id==='end-to-end-a'
    ? {...p,name:'End To End Renamed',previousName:'End To End A',syncStatus:'pending',updatedAt:'2026-11-14T10:05:00.000Z'} : p);
  localState.timeEntries=localState.timeEntries.map(e=>e.id==='end-to-end-entry'? {...e,projectName:'End To End Renamed'}:e);
  const renamed=await api.syncTimeEntries();
  assert.equal(renamed.uploaded,0);
  assert.equal(localState.projects.find(p=>p.id==='end-to-end-a').name,'End To End Renamed');
  assert.equal(localState.projects.find(p=>p.id==='end-to-end-a').syncStatus,'synced');
  assert.equal(spreadsheet.getSheetByName('21.11.2026').rows[1][0],'End To End Renamed');

  localState.deletedEntryIds=['end-to-end-entry'];
  localState.timeEntries=localState.timeEntries.filter(e=>e.id!=='end-to-end-entry');
  await api.syncTimeEntries();
  assert.equal(localState.deletedEntryIds.length,0);
  assert.equal(spreadsheet.getSheetByName('21.11.2026').getLastRow(),1);

  const project=localState.projects.find(p=>p.id==='end-to-end-a');
  localState.projects=localState.projects.filter(p=>p.id!==project.id);
  localState.deletedProjects=[{id:project.id,remoteProjectId:project.remoteProjectId,name:project.name,previousName:project.previousName}];
  await api.syncTimeEntries();
  assert.equal(localState.deletedProjects.length,0);
  assert.equal(localState.projects.some(p=>p.id===project.id),false);
  assert.equal(localState.projects.some(p=>p.id==='end-to-end-b'),true);
});

test('rename does not hijack an unrelated remote project with the former name', () => {
  syncData({...base,projects:[{id:'remote-owner',name:'Protected Name',syncStatus:'pending'}],entries:[]});
  assert.throws(() => syncData({...base,projects:[{
    id:'stale-local',remoteProjectId:'stale-remote',name:'Renamed Name',
    previousName:'Protected Name',syncStatus:'pending',
  }],entries:[]}), /ID проекта в таблице не совпадает/);
  assert.ok(spreadsheet.getDeveloperMetadata().some(m=>m.getKey()==='TRACKER_PROJECT_V3' && JSON.parse(m.getValue()).name==='Protected Name'));
});

test('deletion cleans legacy rows whose stored project ID is stale, preventing resurrection', () => {
  const id='regression-stale-project';
  syncData({ ...base, projects:[{id,name:'Regression Stale',syncStatus:'pending'}], entries:[{
    id:'regression-stale-entry',sessionId:'regression-stale-session',projectId:id,
    projectName:'Regression Stale',date:'2026-11-22',startedAt:'2026-11-22T10:00:00Z',
    endedAt:'2026-11-22T10:30:00Z',durationMs:1800000,timeZone:'UTC',
  }] });
  const sheet=spreadsheet.getSheetByName('22.11.2026');
  const item=sheet.rowMeta.get(2)[0];
  item.setValue(JSON.stringify({ ...JSON.parse(item.getValue()), projectId:'obsolete-local-alias' }));
  const result=syncData({ ...base, projects:[],entries:[], deletedProjects:[{id,name:'Regression Stale'}] });
  assert.equal(sheet.getLastRow(),1);
  assert.equal(result.projects.some(project=>project.name==='Regression Stale'),false);
  const followup=syncData({ ...base, projects:[],entries:[] });
  assert.equal(followup.projects.some(project=>project.name==='Regression Stale'),false);
});

test('deletion retries cleanup of an orphaned spreadsheet row after project metadata vanished', () => {
  const id='regression-orphan-project';
  syncData({ ...base, projects:[{id,name:'Regression Orphan',syncStatus:'pending'}], entries:[{
    id:'regression-orphan-entry',sessionId:'regression-orphan-session',projectId:id,
    projectName:'Regression Orphan',date:'2026-11-23',startedAt:'2026-11-23T10:00:00Z',
    endedAt:'2026-11-23T10:30:00Z',durationMs:1800000,timeZone:'UTC',
  }] });
  const sheet=spreadsheet.getSheetByName('23.11.2026');
  const metadata=spreadsheet.metadata.find(item=>item.getKey()==='TRACKER_PROJECT_V3' && JSON.parse(item.getValue()).id===id);
  metadata.remove(); // simulate a partially completed previous deletion
  assert.equal(sheet.getLastRow(),2);
  const result=syncData({ ...base, projects:[],entries:[], deletedProjects:[{id,name:'Regression Orphan'}] });
  assert.equal(result.projects.some(project=>project.name==='Regression Orphan'),false);
  assert.equal(sheet.getLastRow(),1);
});

test('extension will not resurrect a deleted project even when server acknowledges yet returns it', async () => {
  const tombstone={id:'deleted-ghost',remoteProjectId:'deleted-ghost',name:'Regression Ghost'};
  let localState={
    dateTabsMigrationV3:true,
    projects:[],timeEntries:[],deletedEntryIds:[],
    deletedProjects:[tombstone],deletedProjectsHistory:[tombstone],
  };
  let serverHasGhost=true;
  globalThis.chrome={storage:{local:{
    async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(localState[k])]));},
    async set(value){localState={...localState,...structuredClone(value)};},
  }}};
  globalThis.__fakeAxios={post:async(_url,json)=>{
    const body=JSON.parse(json);
    return { data:{ok:true,version:'4.0.0',uploaded:0,deleted:0,createdTabs:0,
      deletedProjectIds:body.deletedProjects.map(item=>item.id),
      projects:serverHasGhost?[{id:'deleted-ghost',name:'Regression Ghost'}]:[], entries:[] } };
  }};
  const raw=await fs.readFile(new URL('../src/features/google-sheets/api/googleSheetsApi.js',import.meta.url),'utf8');
  const source=raw.replace("import axios from 'axios';",'const axios = globalThis.__fakeAxios;')
    .replaceAll('import.meta.env.VITE_WEB_APP_URL',JSON.stringify('https://script.google.com/macros/s/deployment/exec'))
    .replaceAll('import.meta.env.VITE_SYNC_SECRET',JSON.stringify('private-test-secret'));
  const api=await import(`data:text/javascript,${encodeURIComponent(source)}#regression-ghost`);
  await assert.rejects(api.syncTimeEntries(),/снова вернул удалённый проект/);
  assert.deepEqual(localState.projects,[]);
  assert.equal(localState.deletedProjects.length,1,'retry queue is retained');
  serverHasGhost=false;
  await api.syncTimeEntries();
  assert.deepEqual(localState.projects,[]);
  assert.equal(localState.deletedProjects.length,0,'ack removes the retry queue');
  assert.equal(localState.deletedProjectsHistory.length,1,'permanent guard remains');
  serverHasGhost=true;
  await assert.rejects(api.syncTimeEntries(),/снова вернул удалённый проект/);
  assert.deepEqual(localState.projects,[]);
  assert.equal(localState.deletedProjects[0].id,'deleted-ghost','history requeues resurrection');
});
