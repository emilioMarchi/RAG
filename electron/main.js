import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

let mainWindow = null;
let backendProcess = null;
const BACKEND_PORT = 3000;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

function startBackend() {
  return new Promise((resolve, reject) => {
    const backendEntry = join(__dirname, '..', 'dist', 'index.js');
    backendProcess = spawn('node', [backendEntry], {
      cwd: join(__dirname, '..'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    backendProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[Backend]', msg);
      if (msg.includes('RAG API running')) {
        resolve();
      }
    });

    backendProcess.stderr.on('data', (data) => {
      console.error('[Backend ERR]', data.toString());
    });

    backendProcess.on('error', reject);

    // Safety fallback: resolve after 5s even if log line doesn't appear
    setTimeout(resolve, 5000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1117',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: join(__dirname, '..', 'public', 'icon.png'),
  });

  mainWindow.loadFile(join(__dirname, '..', 'public', 'index.html'));
  
  // Abrimos las herramientas de desarrollo para depurar errores de consola
  mainWindow.webContents.openDevTools();

  // IPC: window controls
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  // IPC: open file dialog
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documentos', extensions: ['pdf', 'docx', 'txt', 'md'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    return result.filePaths;
  });

  // IPC: get backend URL
  ipcMain.handle('backend:url', () => BACKEND_URL);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    console.error('Failed to start backend:', err);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
