import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

let storage = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((name) => [name, storage[name]]));
      },
      async set(values) {
        storage = { ...storage, ...structuredClone(values) };
      },
    },
  },
};

const file = new URL('../src/entities/project/api/projectStorage.js', import.meta.url);
let source = await fs.readFile(file, 'utf8');
source = source.replace("from '@/shared/lib/time'", `from '${new URL('../src/shared/lib/time.js', import.meta.url).href}'`);
const projectApi = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const entryApi = await import('../src/entities/time-entry/api/timeEntryStorage.js');

test('create, start with task description, resume, stop, rename and delete a project', async () => {
  storage = {};
  const project = await projectApi.createProject('NBD.by');
  await projectApi.startProject(project.id, 'Верстка главной страницы');
  await projectApi.pauseProject(project.id);
  await projectApi.startProject(project.id, 'Это описание не должно заменить исходное');
  storage.projects[0].startedAt -= 3000;
  await projectApi.stopProject(project.id);

  assert.equal(storage.projects[0].status, 'idle');
  assert.equal(storage.timeEntries[0].taskDescription, 'Верстка главной страницы');
  assert.equal(storage.projects[0].taskDescription, '');
  await projectApi.renameProject({ projectId: project.id, name: 'NBD.by Website' });
  assert.equal(storage.timeEntries[0].projectName, 'NBD.by Website');
  assert.equal(storage.projects[0].id, project.id);
  assert.equal(storage.projects[0].syncStatus, 'pending');

  const ids = storage.timeEntries.map((entry) => entry.id);
  await projectApi.deleteProject(project.id);
  assert.equal(storage.projects.length, 0);
  assert.equal(storage.timeEntries.length, 0);
  assert.deepEqual(storage.deletedEntryIds, ids);
  assert.deepEqual(storage.deletedProjects[0].name, 'NBD.by Website');
  assert.equal(storage.deletedProjectsHistory[0].id, project.id);
});

test('cannot delete active project or create duplicate project names', async () => {
  storage = {};
  const project = await projectApi.createProject('DeStyle');
  await assert.rejects(projectApi.createProject(' destyle '), /уже существует/);
  await projectApi.startProject(project.id, 'Проверка');
  await assert.rejects(projectApi.deleteProject(project.id), /завершите/);
});

test('session deletion queues all split daily entries', async () => {
  storage = {};
  const project = await projectApi.createProject('Тест');
  storage.projects[0].totalMs = 1800000;
  storage.timeEntries = [
    { id: 'entry1', sessionId: 's1', projectId: project.id, durationMs: 1200000 },
    { id: 'entry2', sessionId: 's1', projectId: project.id, durationMs: 600000 },
  ];
  const result = await entryApi.deleteTimeSession('s1');
  assert.equal(result.deleted, 2);
  assert.equal(storage.projects[0].totalMs, 0);
  assert.equal(storage.timeEntries.length, 0);
  assert.deepEqual(storage.deletedEntryIds.sort(), ['entry1', 'entry2']);
});

test('Google Sheets decimal hour conversion', async () => {
  const script = await fs.readFile(new URL('../legacy/google-apps-script/Code.gs', import.meta.url), 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(script, context);
  vm.runInContext('testHours()', context);
  assert.equal(vm.runInContext('decimalHours(30 * 60000)', context), 0.5);
  assert.equal(vm.runInContext('decimalHours(45 * 60000)', context), 0.75);
});

test('project names invalid for Google Sheets are rejected locally before synchronization', async () => {
  storage = {};
  const project=await projectApi.createProject('Safe Project');
  for (const bad of ['=1+1','+formula','-unsafe','@unsafe']) {
    await assert.rejects(projectApi.createProject(bad), /корректное название/);
    await assert.rejects(projectApi.renameProject({projectId:project.id,name:bad}), /корректное название/);
  }
  assert.equal(storage.projects[0].name,'Safe Project');
});
