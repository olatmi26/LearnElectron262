const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell, clipboard, nativeImage, Tray, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let tray = null;
let isQuitting = false;

function getScreenshotsDir() {
    return path.join(app.getPath('pictures'), 'Screenshots');
}

function getTimestampedFilePath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `screenshot-${timestamp}.png`;
    return path.join(getScreenshotsDir(), fileName);
}

function getSenderWindow(event) {
    return BrowserWindow.fromWebContents(event.sender);
}

async function getDisplaySource(targetDisplay) {
    const thumbnailSize = {
        width: Math.max(1, Math.floor(targetDisplay.size.width * targetDisplay.scaleFactor)),
        height: Math.max(1, Math.floor(targetDisplay.size.height * targetDisplay.scaleFactor))
    };

    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize
    });

    if (!sources || !sources.length) {
        throw new Error('No screen sources available');
    }

    const matchedSource = sources.find((source) => source.display_id === String(targetDisplay.id));
    return matchedSource || sources[0];
}

function getDisplayForWindow(win) {
    if (!win) {
        return screen.getPrimaryDisplay();
    }
    const bounds = win.getBounds();
    return screen.getDisplayMatching(bounds);
}

function getRegionFromInput(region) {
    return {
        x: Math.max(0, Math.floor(region && typeof region.x === 'number' ? region.x : 0)),
        y: Math.max(0, Math.floor(region && typeof region.y === 'number' ? region.y : 0)),
        width: Math.max(1, Math.floor(region && typeof region.width === 'number' ? region.width : 1)),
        height: Math.max(1, Math.floor(region && typeof region.height === 'number' ? region.height : 1))
    };
}

async function captureWithWindowHidden(event, captureAction) {
    const win = getSenderWindow(event);
    const wasVisible = Boolean(win && win.isVisible());
    const wasAlwaysOnTop = Boolean(win && win.isAlwaysOnTop());

    try {
        if (win) {
            // Reduce the chance of this app appearing in captures.
            win.setIgnoreMouseEvents(true);
            win.setOpacity(0);
            win.hide();
        }

        await new Promise((resolve) => setTimeout(resolve, 220));
        return await captureAction();
    } finally {
        if (win) {
            win.setIgnoreMouseEvents(false);
            win.setOpacity(1);
            win.setAlwaysOnTop(wasAlwaysOnTop);
            if (wasVisible) {
                win.show();
                win.focus();
            }
        }
    }
}

function createWindow() {
    const iconPath = path.join(__dirname, 'assets', 'camera.ico');

    mainWindow = new BrowserWindow({
        width: 140,
        height: 140,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
        },
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        icon: iconPath,
        show: false
    });

    mainWindow.loadFile('index.html');
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function ensureMainWindow() {
    if (!mainWindow) {
        createWindow();
    }
    return mainWindow;
}

function emitToRenderer(channel) {
    const win = ensureMainWindow();
    if (!win) {
        return;
    }

    const sendEvent = () => win.webContents.send(channel);
    if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', sendEvent);
    } else {
        sendEvent();
    }
}

function createTray() {
    const trayIconPath = path.join(__dirname, 'assets', 'camera.ico');
    tray = new Tray(trayIconPath);
    tray.setToolTip('Screen Capture');

    const contextMenu = Menu.buildFromTemplate([{
            label: 'Show',
            click: () => {
                ensureMainWindow();
                mainWindow.show();
                mainWindow.focus();
            }
        },
        {
            label: 'Capture Full Screen',
            click: () => {
                emitToRenderer('tray-capture-fullscreen');
            }
        },
        {
            label: 'Capture Area',
            click: () => {
                ensureMainWindow();
                mainWindow.show();
                mainWindow.focus();
                emitToRenderer('tray-capture-area');
            }
        },
        { type: 'separator' },
        {
            label: 'Hide',
            click: () => {
                if (mainWindow) {
                    mainWindow.hide();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => app.quit()
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        ensureMainWindow();
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(() => {
    createWindow();
    createTray();
});

app.on('window-all-closed', (event) => {
    event.preventDefault();
});

app.on('before-quit', () => {
    isQuitting = true;
});

ipcMain.handle('enter-selection-mode', async(event) => {
    const win = getSenderWindow(event);
    if (!win) {
        return { ok: false };
    }

    try {
        return await captureWithWindowHidden(event, async() => {
            const display = getDisplayForWindow(win);
            const source = await getDisplaySource(display);
            const previewImage = source.thumbnail;

            win.__previousBounds = win.getBounds();
            win.__selectionDisplayId = display.id;
            win.__selectionDisplaySize = display.size;
            win.__selectionImageSize = previewImage.getSize();
            win.__selectionImagePng = previewImage.toPNG();

            win.setBackgroundColor('#00000000');
            win.setAlwaysOnTop(true, 'screen-saver');
            win.setBounds(display.bounds);
            win.show();
            win.focus();

            return {
                ok: true,
                previewDataUrl: `data:image/png;base64,${win.__selectionImagePng.toString('base64')}`
            };
        });
    } catch (err) {
        console.error('Error entering selection mode:', err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('exit-selection-mode', (event) => {
    const win = getSenderWindow(event);
    if (!win) {
        return { ok: false };
    }

    if (win.__previousBounds) {
        win.setBounds(win.__previousBounds);
        win.__previousBounds = null;
    }
    win.__selectionDisplayId = null;
    win.__selectionDisplaySize = null;
    win.__selectionImageSize = null;
    win.__selectionImagePng = null;
    win.setAlwaysOnTop(false);
    return { ok: true };
});

ipcMain.handle('capture-screen', async(event) => {
    try {
        return await captureWithWindowHidden(event, async() => {
            const win = getSenderWindow(event);
            const display = getDisplayForWindow(win);
            const source = await getDisplaySource(display);
            const capturedImage = source.thumbnail;
            const img = capturedImage.toPNG();
            const screenshotsDir = getScreenshotsDir();
            await fs.promises.mkdir(screenshotsDir, { recursive: true });
            const filePath = getTimestampedFilePath();

            clipboard.writeImage(nativeImage.createFromBuffer(img));
            await fs.promises.writeFile(filePath, img);
            await shell.openPath(filePath);
            return { ok: true, filePath, copiedToClipboard: true };
        });
    } catch (err) {
        console.error('Error capturing screen:', err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('capture-region', async(event, region) => {
    try {
        const inputRect = getRegionFromInput(region);
        return await captureWithWindowHidden(event, async() => {
            const win = getSenderWindow(event);
            let image;
            let imageSize;
            let displaySize;

            if (win && win.__selectionImagePng && win.__selectionDisplaySize) {
                image = nativeImage.createFromBuffer(win.__selectionImagePng);
                imageSize = win.__selectionImageSize || image.getSize();
                displaySize = win.__selectionDisplaySize;
            } else {
                const selectionDisplayId = win && win.__selectionDisplayId ? Number(win.__selectionDisplayId) : null;
                const selectedDisplay = selectionDisplayId ?
                    screen.getAllDisplays().find((d) => d.id === selectionDisplayId) :
                    null;
                const display = selectedDisplay || getDisplayForWindow(win);
                const source = await getDisplaySource(display);
                image = source.thumbnail;
                imageSize = image.getSize();
                displaySize = display.size;
            }

            const scaleX = imageSize.width / displaySize.width;
            const scaleY = imageSize.height / displaySize.height;
            const x = Math.max(0, Math.floor(inputRect.x * scaleX));
            const y = Math.max(0, Math.floor(inputRect.y * scaleY));
            const w = Math.max(1, Math.floor(inputRect.width * scaleX));
            const h = Math.max(1, Math.floor(inputRect.height * scaleY));

            const cropWidth = Math.min(w, imageSize.width - x);
            const cropHeight = Math.min(h, imageSize.height - y);

            if (cropWidth <= 0 || cropHeight <= 0) {
                throw new Error('Invalid capture region');
            }

            const cropped = image.crop({ x, y, width: cropWidth, height: cropHeight });
            const screenshotsDir = getScreenshotsDir();
            await fs.promises.mkdir(screenshotsDir, { recursive: true });
            const filePath = getTimestampedFilePath();

            clipboard.writeImage(cropped);
            await fs.promises.writeFile(filePath, cropped.toPNG());
            await shell.openPath(filePath);
            return { ok: true, filePath, copiedToClipboard: true };
        });
    } catch (err) {
        console.error('Error capturing region:', err);
        return { ok: false, error: err.message };
    }
});