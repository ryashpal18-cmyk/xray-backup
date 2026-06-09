const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { google } = require('googleapis');
const Store = require('electron-store');
const { getPatientInfo } = require('./patient-reader');

const store = new Store();

let mainWindow = null;
let tray = null;
let watcher = null;
let uploadQueue = [];
let isUploading = false;
let driveService = null;
let backupFolderId = null;
let isWatching = false;

// Default paths
const DEFAULT_WATCH = 'C:\\KonicaMinolta\\Kim\\Server\\Data\\Image';

// Save install date — pehli baar jo date hogi wahi rahegi hamesha
if (!store.get('installDate')) {
  store.set('installDate', new Date().toISOString().split('T')[0]);
}
const INSTALL_DATE = new Date(store.get('installDate'));

// Stats
let stats = {
  totalUploaded: store.get('stats.totalUploaded', 0),
  todayUploaded: 0,
  lastUpload: store.get('stats.lastUpload', null),
  lastPatient: store.get('stats.lastPatient', null),
};

// ── App Ready ─────────────────────────────────────────────
app.whenReady().then(async () => {
  createTray();
  createWindow();

  const credentials = store.get('credentials');
  const watchPath = store.get('watchPath', DEFAULT_WATCH);

  if (credentials) {
    const ok = await initGoogleDrive(credentials);
    if (ok) {
      startWatching(watchPath);
      // Auto-delete: roz check karo
      setTimeout(runAutoDelete, 5000);
      setInterval(runAutoDelete, 24 * 60 * 60 * 1000);
    }
  }
});

// ── Auto Delete 1 Saal Purani Files ──────────────────────
async function runAutoDelete() {
  if (!driveService || !backupFolderId) return;
  try {
    log('🗑️ Auto-delete check shuru...');
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const res = await driveService.files.list({
      q: `'${backupFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
    });

    let deletedCount = 0;
    for (const folder of res.data.files) {
      const folderDate = new Date(folder.name);
      if (isNaN(folderDate.getTime())) continue;
      if (folderDate < oneYearAgo) {
        await driveService.files.delete({ fileId: folder.id });
        log('🗑️ Deleted: ' + folder.name);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      log('✅ Auto-delete: ' + deletedCount + ' purane folders delete hue');
      sendToRenderer('log', '[Auto-Delete] ' + deletedCount + ' folders deleted');
    } else {
      log('✅ Auto-delete: Koi purana folder nahi');
    }
  } catch (err) {
    log('⚠️ Auto-delete error: ' + err.message);
  }
}

app.on('window-all-closed', (e) => e.preventDefault());

// ── Tray ──────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  updateTrayMenu();
  tray.setToolTip('XRay Backup Pro — Konica Minolta');
  tray.on('double-click', () => mainWindow ? mainWindow.show() : createWindow());
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '🩻 XRay Backup Pro', enabled: false },
    { type: 'separator' },
    { label: `✅ Aaj: ${stats.todayUploaded} X-rays`, enabled: false },
    { label: `👤 Last: ${stats.lastPatient || 'None'}`, enabled: false },
    { label: `📋 Queue: ${uploadQueue.length}`, enabled: false },
    { type: 'separator' },
    { label: '📂 Dashboard Kholo', click: () => mainWindow ? mainWindow.show() : createWindow() },
    { label: '☁️ Google Drive Kholo', click: () => shell.openExternal('https://drive.google.com') },
    { type: 'separator' },
    { label: '❌ Band Karo', click: () => app.exit(0) },
  ]);
  tray.setContextMenu(menu);
}

// ── Window ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920, height: 640,
    minWidth: 750, minHeight: 520,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: 'XRay Backup Pro',
    backgroundColor: '#060c1a',
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => { e.preventDefault(); mainWindow.hide(); });
}

// ── Google Drive ──────────────────────────────────────────
async function initGoogleDrive(credentials) {
  try {
    const { client_id, client_secret, refresh_token } = credentials;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, 'urn:ietf:wg:oauth:2.0:oob');
    oauth2.setCredentials({ refresh_token });
    driveService = google.drive({ version: 'v3', auth: oauth2 });
    backupFolderId = await getOrCreateFolder('XRay_Backup_Balaji', null);
    sendToRenderer('auth-status', { connected: true });
    log('✅ Google Drive connected!');
    return true;
  } catch (err) {
    log('❌ Drive error: ' + err.message);
    sendToRenderer('auth-status', { connected: false });
    driveService = null;
    return false;
  }
}

async function getOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await driveService.files.list({ q, fields: 'files(id,name)' });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const f = await driveService.files.create({ requestBody: meta, fields: 'id' });
  return f.data.id;
}

// ── File Watcher ──────────────────────────────────────────
function startWatching(watchPath) {
  if (watcher) watcher.close();
  if (!fs.existsSync(watchPath)) {
    log(`⚠️ Folder nahi mila: ${watchPath}`);
    sendToRenderer('watch-status', { watching: false, error: 'Folder not found' });
    return;
  }

  // Watch only .ihd files — these are created AFTER image is fully saved
  // .ihd = ImageHeader XML — contains ReadDateTime, study info
  watcher = chokidar.watch(watchPath, {
    persistent: true,
    ignoreInitial: true,
    ignored: /\.(OrgImg|Img|Ref|OrgImg)$/,
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 500 },
  });

  watcher.on('add', (filePath) => {
    // Only process .ihd files (main trigger)
    if (filePath.endsWith('.ihd')) {
      log(`🆕 New X-ray: ${path.basename(filePath)}`);
      addToQueue(filePath);
    }
  });

  isWatching = true;
  log(`👁️ Watch shuru: ${watchPath}`);
  sendToRenderer('watch-status', { watching: true, path: watchPath });
  updateTrayMenu();
}

function stopWatching() {
  if (watcher) { watcher.close(); watcher = null; }
  isWatching = false;
  sendToRenderer('watch-status', { watching: false });
  log('⏹️ Watch band');
  updateTrayMenu();
}

// ── Upload Queue ──────────────────────────────────────────
function addToQueue(ihdPath) {
  uploadQueue.push(ihdPath);
  sendToRenderer('queue-update', { queue: uploadQueue.length });
  updateTrayMenu();
  if (!isUploading) processQueue();
}

async function processQueue() {
  if (uploadQueue.length === 0 || !driveService) {
    isUploading = false;
    return;
  }
  isUploading = true;
  const ihdPath = uploadQueue.shift();

  try {
    await uploadXray(ihdPath);
  } catch (err) {
    log(`❌ Upload fail: ${path.basename(ihdPath)} — ${err.message}`);
    // Retry after 60s
    setTimeout(() => { uploadQueue.push(ihdPath); if (!isUploading) processQueue(); }, 60000);
  }

  sendToRenderer('queue-update', { queue: uploadQueue.length });
  updateTrayMenu();
  processQueue();
}

async function uploadXray(ihdPath) {
  const baseDir = path.dirname(ihdPath);
  const baseName = path.basename(ihdPath, '.ihd'); // e.g. "3724_0"

  // ── Get patient info ──
  log(`🔍 Patient info padh raha hun...`);
  sendToRenderer('upload-start', { file: baseName, patient: 'Dhoondh raha hun...' });

  const info = getPatientInfo(ihdPath);
  const displayName = info.patientName || `LID-${info.patientLid || baseName}`;
  const folderName = info.folderName || baseName;

  log(`👤 Patient: ${displayName} | Study: ${info.studyType || 'N/A'}`);
  sendToRenderer('upload-start', { file: baseName, patient: displayName });

  // ── Create Drive folders ──
  const today = (info.readDateTime || new Date().toISOString()).split('T')[0];
  const dateFolderId = await getOrCreateFolder(today, backupFolderId);
  const patientFolderId = await getOrCreateFolder(folderName, dateFolderId);

  // ── Find all related files ──
  // Files: 3724_0.Img, 3724_0.OrgImg, 3724_0.Ref, 3724_0.ihd, 3724_0.Orgihd, 3724_0.Initihd
  const allFiles = fs.readdirSync(baseDir)
    .filter(f => f.startsWith(baseName))
    .map(f => path.join(baseDir, f))
    .filter(f => fs.existsSync(f));

  log(`📁 ${allFiles.length} files milein upload ke liye`);

  for (const f of allFiles) {
    await uploadSingleFile(f, patientFolderId);
  }

  // ── Upload patient info text ──
  const infoText = [
    '=== X-RAY PATIENT INFO ===',
    `Patient Name : ${info.patientName || 'N/A'}`,
    `Patient ID   : ${info.patientId || 'N/A'}`,
    `Patient LID  : ${info.patientLid || 'N/A'}`,
    `Study Type   : ${info.studyType || 'N/A'}`,
    `Date & Time  : ${info.readDateTime || 'N/A'}`,
    `Backup Time  : ${new Date().toLocaleString('en-IN')}`,
    `Files        : ${allFiles.map(f => path.basename(f)).join(', ')}`,
    '=========================='
  ].join('\n');

  await uploadTextContent('patient_info.txt', infoText, patientFolderId);

  // ── Update stats ──
  stats.totalUploaded++;
  stats.todayUploaded++;
  stats.lastUpload = new Date().toLocaleString('en-IN');
  stats.lastPatient = displayName;
  store.set('stats.totalUploaded', stats.totalUploaded);
  store.set('stats.lastUpload', stats.lastUpload);
  store.set('stats.lastPatient', displayName);

  log(`✅ Upload done: ${displayName} → ${folderName}`);
  sendToRenderer('upload-done', { file: baseName, patient: displayName, folderName, stats });
  updateTrayMenu();
}

async function uploadSingleFile(filePath, folderId) {
  const fileName = path.basename(filePath);
  log(`   ⬆️ ${fileName}`);
  await driveService.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { body: fs.createReadStream(filePath) },
    fields: 'id',
  });
}

async function uploadTextContent(fileName, content, folderId) {
  const { Readable } = require('stream');
  await driveService.files.create({
    requestBody: { name: fileName, mimeType: 'text/plain', parents: [folderId] },
    media: { mimeType: 'text/plain', body: Readable.from([content]) },
    fields: 'id',
  });
}

// ── IPC ───────────────────────────────────────────────────
ipcMain.handle('get-store', (e, k) => store.get(k));
ipcMain.handle('set-store', (e, k, v) => store.set(k, v));
ipcMain.handle('get-stats', () => stats);
ipcMain.handle('get-logs', () => logBuffer);
ipcMain.handle('is-watching', () => isWatching);

ipcMain.handle('connect-drive', async (e, creds) => {
  store.set('credentials', creds);
  return await initGoogleDrive(creds);
});

ipcMain.handle('start-watch', (e, p) => { store.set('watchPath', p); startWatching(p); });
ipcMain.handle('stop-watch', () => stopWatching());
ipcMain.handle('open-drive', () => shell.openExternal('https://drive.google.com'));

ipcMain.handle('test-connection', async () => {
  if (!driveService) return { success: false, error: 'Connected nahi hai' };
  try {
    await driveService.files.list({ pageSize: 1, fields: 'files(id)' });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Log ───────────────────────────────────────────────────
let logBuffer = [];
function log(msg) {
  const entry = `[${new Date().toLocaleTimeString('en-IN')}] ${msg}`;
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  console.log(entry);
  sendToRenderer('log', entry);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'backup.log'), entry + '\n');
  } catch (e) {}
}

function sendToRenderer(ch, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data);
}
