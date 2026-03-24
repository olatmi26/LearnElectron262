const { ipcRenderer } = require("electron");

const cameraButton = document.getElementById("camera-btn");
const cameraShell = document.querySelector(".camera-shell");
let clickTimer = null;
let selectionMode = false;
let selectionStarted = false;
let startX = 0;
let startY = 0;
let selectionOverlay = null;
let selectionBox = null;

async function runFullCapture() {
    cameraButton.classList.add("hidden");
    try {
        await ipcRenderer.invoke("capture-screen");
    } finally {
        cameraButton.classList.remove("hidden");
    }
}

function normalizeRect(x1, y1, x2, y2) {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    return { x, y, width, height };
}

function cleanupSelectionUi() {
    if (selectionOverlay) {
        selectionOverlay.remove();
        selectionOverlay = null;
    }
    selectionBox = null;
    document.body.classList.remove("selection-mode");
    if (cameraShell) {
        cameraShell.classList.remove("hidden");
    }
}

function drawSelectionBox(currentX, currentY) {
    if (!selectionBox) {
        return;
    }
    const rect = normalizeRect(startX, startY, currentX, currentY);
    selectionBox.style.left = `${rect.x}px`;
    selectionBox.style.top = `${rect.y}px`;
    selectionBox.style.width = `${rect.width}px`;
    selectionBox.style.height = `${rect.height}px`;
}

async function enterSelectionMode() {
    if (selectionMode) {
        return;
    }
    const result = await ipcRenderer.invoke("enter-selection-mode");
    if (!result?.ok) {
        return;
    }

    selectionMode = true;
    selectionStarted = false;
    document.body.classList.add("selection-mode");
    if (cameraShell) {
        cameraShell.classList.add("hidden");
    }

    selectionOverlay = document.createElement("div");
    selectionOverlay.className = "selection-overlay";
    if (result.previewDataUrl) {
        selectionOverlay.style.backgroundImage = `url("${result.previewDataUrl}")`;
    }
    selectionBox = document.createElement("div");
    selectionBox.className = "selection-box";
    selectionOverlay.appendChild(selectionBox);
    document.body.appendChild(selectionOverlay);
}

if (cameraButton) {
    cameraButton.draggable = false;
    cameraButton.addEventListener("dragstart", (event) => {
        event.preventDefault();
    });

    cameraButton.addEventListener("click", () => {
        if (selectionMode) {
            return;
        }
        if (clickTimer) {
            clearTimeout(clickTimer);
        }
        clickTimer = setTimeout(async () => {
            try {
                await runFullCapture();
            } finally {
                clickTimer = null;
            }
        }, 220);
    });

    cameraButton.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
        }
        await enterSelectionMode();
    });

    window.addEventListener("mousedown", (event) => {
        if (!selectionMode || event.button !== 0) {
            return;
        }
        selectionStarted = true;
        startX = event.clientX;
        startY = event.clientY;
        drawSelectionBox(startX, startY);
    });

    window.addEventListener("mousemove", (event) => {
        if (!selectionMode || !selectionStarted) {
            return;
        }
        drawSelectionBox(event.clientX, event.clientY);
    });

    window.addEventListener("mouseup", async (event) => {
        if (!selectionMode || event.button !== 0 || !selectionStarted) {
            return;
        }
        selectionStarted = false;

        const rect = normalizeRect(startX, startY, event.clientX, event.clientY);
        cleanupSelectionUi();
        selectionMode = false;

        try {
            if (rect.width > 3 && rect.height > 3) {
                await ipcRenderer.invoke("capture-region", rect);
            }
        } finally {
            await ipcRenderer.invoke("exit-selection-mode");
        }
    });

    window.addEventListener("keydown", async (event) => {
        if (!selectionMode || event.key !== "Escape") {
            return;
        }
        selectionStarted = false;
        selectionMode = false;
        cleanupSelectionUi();
        await ipcRenderer.invoke("exit-selection-mode");
    });

    ipcRenderer.on("tray-capture-fullscreen", async () => {
        if (selectionMode) {
            return;
        }
        await runFullCapture();
    });

    ipcRenderer.on("tray-capture-area", async () => {
        if (selectionMode) {
            return;
        }
        await enterSelectionMode();
    });
}