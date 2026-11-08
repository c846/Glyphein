const { app, BrowserWindow, Menu } = require('electron');

// No native menu: the app's menu will be built by hand.
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({ width: 1000, height: 800 });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
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
