const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } = require('fs');
const path = require('path');
const wordnet = require('./wordnet.js');

// Glyphein used to be called The Pillprocessor, and Electron keeps each app's
// saved data (the spelling language, ignored words) in a folder named after
// it. Move the old folder's contents into the new one, item by item: Electron
// may already have made the new folder, but never overwrite anything in it.
// Runs before the app starts, so nothing in either folder is in use.
function moveOldData() {
  const oldFolder = path.join(app.getPath('appData'), 'the-pillprocessor');
  if (!existsSync(oldFolder)) return;
  const newFolder = app.getPath('userData');
  try {
    mkdirSync(newFolder, { recursive: true });
    for (const entry of readdirSync(oldFolder)) {
      const target = path.join(newFolder, entry);
      if (!existsSync(target)) renameSync(path.join(oldFolder, entry), target);
    }
    // Only once it's empty: anything left was not moved, so keep it.
    rmdirSync(oldFolder);
  } catch (error) {
    console.error(`Could not finish moving saved data from ${oldFolder}: ${error.message}`);
  }
}
moveOldData();

// The app's icon, in place of Electron's: the title bar, taskbar, Alt+Tab
// and the macOS dock.
const ICON = path.join(__dirname, 'icon.png');

// Its own identity on Windows, so the taskbar groups and labels its windows
// as Glyphein (with the icon above) rather than as Electron.
if (process.platform === 'win32') app.setAppUserModelId('com.c846.glyphein');

// No native menu: the app's menu will be built by hand.
Menu.setApplicationMenu(null);

ipcMain.handle('wordnet:lookup', (_event, word) => wordnet.lookup(String(word)));

/* ---------- Files ---------- */

const ODT_FILTERS = [{ name: 'OpenDocument Text', extensions: ['odt'] }];

const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

// Windows whose document has unsaved changes.
const unsaved = new WeakSet();

// Resolves to { path, bytes }, or null if cancelled.
ipcMain.handle('file:open', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(windowOf(event), {
    title: 'Open',
    filters: ODT_FILTERS,
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return { path: filePaths[0], bytes: await fs.readFile(filePaths[0]) };
});

// Writes to `path`, first asking where if `ask` is set or there is no path.
// Resolves to the path written, or null if cancelled.
ipcMain.handle('file:save', async (event, bytes, { path: target, ask, title, defaultPath }) => {
  if (ask || !target) {
    const result = await dialog.showSaveDialog(windowOf(event), { title, defaultPath, filters: ODT_FILTERS });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
    if (path.extname(target).toLowerCase() !== '.odt') target += '.odt';
  }
  await writeFileSafely(target, Buffer.from(bytes));
  return target;
});

// Writes a temporary file and then swaps it in, so a failed save never
// leaves a half-written document behind.
async function writeFileSafely(target, data) {
  const temp = path.join(path.dirname(target), `~${path.basename(target)}.${process.pid}.tmp`);
  await fs.writeFile(temp, data);
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

// Resolves to 'save', 'discard' or 'cancel'.
ipcMain.handle('file:confirm-discard', async (event, name) => {
  const { response } = await dialog.showMessageBox(windowOf(event), {
    type: 'warning',
    title: 'Glyphein',
    message: `Do you want to save the changes to ${name}?`,
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.on('file:set-dirty', (event, dirty) => {
  const win = windowOf(event);
  if (!win) return;
  if (dirty) unsaved.add(win);
  else unsaved.delete(win);
});

// The page has dealt with any unsaved changes.
ipcMain.on('app:close', (event) => {
  const win = windowOf(event);
  if (!win) return;
  unsaved.delete(win);
  win.close();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  // Read the dictionary index now, so the first lookup is instant.
  win.webContents.once('did-finish-load', () => setTimeout(wordnet.preload, 0));

  // With unsaved changes, let the page ask what to do first. If the page has
  // crashed it can't answer, so the window just closes.
  win.on('close', (event) => {
    if (!unsaved.has(win) || win.webContents.isCrashed()) return;
    event.preventDefault();
    win.webContents.send('app:close-requested');
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.setIcon(ICON);
  createWindow();

  // macOS: reopen a window when the dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows close, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
