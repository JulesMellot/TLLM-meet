'use strict';

/**
 * TLLM*meet: shared whiteboard.
 *
 * Replaces MiroTalk's whiteboard, whose browsers sent each other their changes (objects got
 * duplicated, a "clear" or an undo went to everyone, and the board was lost when the
 * presenter left). Here every object lives in the Yjs document kept by the server
 * (TllmCollab.js, app/src/Collab.js): one entry per object, so two people can draw at once,
 * late joiners get the board, undo only touches your own changes, and only the people
 * allowed to share can draw (the server drops the rest).
 *
 * The view (zoom, position, tool) is personal. Drawing uses fabric.js, already loaded by MiroTalk.
 */

(() => {
    if (typeof fabric === 'undefined' || !window.tllmCollab) return;

    const $ = (id) => document.getElementById(id);
    const collab = window.tllmCollab;
    const { Y } = collab.lib;
    const LOCAL = 'tllm-board-local';
    const PROPS = ['tllmId', 'tllmZ', 'tllmHighlight'];
    const TYPES = new Set(['path', 'rect', 'ellipse', 'textbox', 'tllmNote', 'image']);
    const IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
    const COLORS = ['#1f2937', '#e5484d', '#2563eb', '#16a34a', '#f59e0b', '#9333ea'];
    const WIDTHS = [2, 5, 10];
    const NOTE_COLOR = '#fde68a';
    const MAX_IMAGE_SIDE = 1600;
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 5;

    const map = collab.doc.getMap('board');
    const undo = new Y.UndoManager(map, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });

    const B = (window.tllmBoard = {
        open: false,
        canvas: null,
        tool: 'pen',
        color: COLORS[0],
        width: WIDTHS[1],
        objects: new Map(), // id -> fabric object
        viewTouched: false,
        map,
        undo,
    });

    let counter = 0;
    const newId = () => `${collab.doc.clientID.toString(36)}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
    const canWrite = () => collab.synced && collab.writable && collab.connected;
    const tell = (title, text = '') =>
        window.tllmRoom?.bubble?.({ iconCls: 'fas fa-chalkboard', title, text, duration: 5000 });

    // ####################################################
    // STICKY NOTE: a text box drawn on a coloured square
    // ####################################################

    const NOTE_PAD = 14;
    const NOTE_MIN_H = 120;
    fabric.TllmNote = fabric.util.createClass(fabric.Textbox, {
        type: 'tllmNote',
        _renderBackground(ctx) {
            const w = this.width + NOTE_PAD * 2;
            const h = Math.max(this.height, NOTE_MIN_H) + NOTE_PAD * 2;
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.18)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetY = 2;
            ctx.fillStyle = this.noteColor || NOTE_COLOR;
            ctx.fillRect(-this.width / 2 - NOTE_PAD, -this.height / 2 - NOTE_PAD, w, h);
            ctx.restore();
        },
        toObject(extra) {
            return this.callSuper('toObject', ['noteColor'].concat(extra || []));
        },
    });
    fabric.TllmNote.fromObject = (object, callback) => fabric.Object._fromObject('TllmNote', object, callback, 'text');

    Object.assign(fabric.Object.prototype, {
        transparentCorners: false,
        cornerColor: '#4c8dff',
        cornerStrokeColor: '#ffffff',
        borderColor: '#4c8dff',
        cornerSize: 10,
        touchCornerSize: 28,
        padding: 4,
    });

    // ####################################################
    // MODEL <-> CANVAS
    // ####################################################

    const zOf = (obj) => obj.tllmZ || 0;
    const before = (a, b) => zOf(a) < zOf(b) || (zOf(a) === zOf(b) && String(a.tllmId) < String(b.tllmId));
    const topZ = () => {
        let z = 0;
        map.forEach((json) => (z = Math.max(z, Number(json?.tllmZ) || 0)));
        return z + 1;
    };

    function serialize(obj) {
        const json = obj.toObject(PROPS);
        delete json.clipPath;
        return json;
    }

    function commit(obj) {
        if (!obj?.tllmId || !canWrite()) return;
        collab.doc.transact(() => map.set(obj.tllmId, serialize(obj)), LOCAL);
    }

    function commitNew(obj) {
        obj.tllmId = newId();
        obj.tllmZ = topZ();
        B.objects.set(obj.tllmId, obj);
        undo.stopCapturing();
        commit(obj);
        applyInteractivity(obj);
    }

    function removeObjects(objs) {
        if (!canWrite() || !objs.length) return;
        undo.stopCapturing();
        collab.doc.transact(() => {
            objs.forEach((obj) => {
                if (obj.tllmId) map.delete(obj.tllmId);
                B.objects.delete(obj.tllmId);
                B.canvas.remove(obj);
            });
        }, LOCAL);
        B.canvas.discardActiveObject();
        B.canvas.requestRenderAll();
    }

    // What comes from the others (or from my own undo) is checked before it is drawn
    function cleanJson(json) {
        if (!json || typeof json !== 'object' || !TYPES.has(json.type)) return null;
        const copy = { ...json };
        delete copy.clipPath;
        delete copy.shadow;
        delete copy.filters;
        delete copy.resizeFilter;
        copy.globalCompositeOperation = 'source-over';
        if (copy.type === 'image' && (typeof copy.src !== 'string' || !IMAGE_SRC.test(copy.src))) return null;
        if (copy.type === 'path' && !Array.isArray(copy.path)) return null;
        if ((copy.type === 'textbox' || copy.type === 'tllmNote') && typeof copy.text === 'string')
            copy.text = copy.text.slice(0, 5000);
        return copy;
    }

    const loading = new Map(); // id -> token, so a slow image cannot overwrite a newer version

    function applyRemote(id) {
        const canvas = B.canvas;
        if (!canvas) return;
        const old = B.objects.get(id);
        const json = cleanJson(map.get(id));
        if (!json) {
            loading.delete(id);
            if (old) {
                canvas.remove(old);
                B.objects.delete(id);
                canvas.requestRenderAll();
            }
            return;
        }
        if (old?.isEditing) return; // I am typing in it: my version wins when I stop
        const token = {};
        loading.set(id, token);
        fabric.util.enlivenObjects([json], ([obj]) => {
            if (loading.get(id) !== token || !obj) return;
            loading.delete(id);
            obj.tllmId = id;
            obj.tllmZ = Number(json.tllmZ) || 0;
            const current = B.objects.get(id);
            const wasActive = current && canvas.getActiveObject() === current;
            if (current) canvas.remove(current);
            const list = canvas.getObjects();
            let index = list.length;
            for (let i = 0; i < list.length; i++) {
                if (list[i].tllmId && before(obj, list[i])) {
                    index = i;
                    break;
                }
            }
            canvas.insertAt(obj, index);
            B.objects.set(id, obj);
            applyInteractivity(obj);
            if (wasActive) canvas.setActiveObject(obj);
            canvas.requestRenderAll();
        });
    }

    map.observe((event, transaction) => {
        if (transaction.origin === LOCAL) return;
        event.keysChanged.forEach(applyRemote);
        updateEmpty();
    });

    function renderAll() {
        if (!B.canvas) return;
        B.objects.forEach((obj) => B.canvas.remove(obj));
        B.objects.clear();
        map.forEach((_, id) => applyRemote(id));
        updateEmpty();
    }

    // ####################################################
    // DOM
    // ####################################################

    const icon = (cls) => `<i class="${cls}" aria-hidden="true"></i>`;
    const TOOLS = [
        ['select', 'fas fa-arrow-pointer', 'Sélectionner', true],
        ['hand', 'fas fa-hand', 'Se déplacer', false],
        ['pen', 'fas fa-pen', 'Stylo', true],
        ['highlighter', 'fas fa-highlighter', 'Surligneur', true],
        ['eraser', 'fas fa-eraser', 'Gomme', true],
        ['rect', 'far fa-square', 'Rectangle', true],
        ['ellipse', 'far fa-circle', 'Ellipse', true],
        ['line', 'fas fa-minus', 'Trait', true],
        ['arrow', 'fas fa-arrow-right-long', 'Flèche', true],
        ['text', 'fas fa-font', 'Texte', true],
        ['note', 'fas fa-note-sticky', 'Post-it', true],
        ['image', 'far fa-image', 'Image ou PDF', true],
    ];

    function buildDom() {
        if ($('tllmBoard')) return;
        const el = document.createElement('section');
        el.id = 'tllmBoard';
        el.className = 'tllm-board notranslate';
        el.setAttribute('translate', 'no');
        el.setAttribute('aria-label', 'Tableau blanc');
        el.hidden = true;
        el.innerHTML = `
            <div class="tllm-board-top">
                <div class="tllm-board-title">
                    <span class="tllm-board-mark">${icon('fas fa-chalkboard')}</span>
                    <span class="tllm-board-name">Tableau blanc</span>
                    <span class="tllm-editor-people" id="tllmBoardPeople"></span>
                    <span class="tllm-editor-status" id="tllmBoardStatus" hidden></span>
                </div>
                <div class="tllm-board-actions">
                    <div class="tllm-board-group tllm-board-write">
                        <button type="button" id="tllmBoardUndo" aria-label="Annuler" title="Annuler (Ctrl+Z)">${icon('fas fa-rotate-left')}</button>
                        <button type="button" id="tllmBoardRedo" aria-label="Rétablir" title="Rétablir (Ctrl+Maj+Z)">${icon('fas fa-rotate-right')}</button>
                    </div>
                    <div class="tllm-board-group">
                        <button type="button" id="tllmBoardZoomOut" aria-label="Dézoomer" title="Dézoomer">${icon('fas fa-minus')}</button>
                        <button type="button" id="tllmBoardZoom" class="tllm-board-zoom" title="Revenir à 100 %">100 %</button>
                        <button type="button" id="tllmBoardZoomIn" aria-label="Zoomer" title="Zoomer">${icon('fas fa-plus')}</button>
                        <button type="button" id="tllmBoardFit" aria-label="Tout afficher" title="Tout afficher">${icon('fas fa-expand')}</button>
                    </div>
                    <div class="tllm-board-group">
                        <button type="button" id="tllmBoardExport" aria-label="Exporter" title="Exporter">${icon('fas fa-download')}</button>
                        <button type="button" id="tllmBoardClear" class="tllm-board-write" aria-label="Tout effacer" title="Tout effacer">${icon('fas fa-trash')}</button>
                    </div>
                    <button type="button" id="tllmBoardClose" aria-label="Fermer" title="Fermer">${icon('fas fa-xmark')}</button>
                </div>
            </div>
            <div class="tllm-board-stage" id="tllmBoardStage">
                <canvas id="tllmBoardCanvas"></canvas>
                <div class="tllm-board-pointers" id="tllmBoardPointers"></div>
                <p class="tllm-board-empty" id="tllmBoardEmpty" hidden>Le tableau est vide.</p>
                <div class="tllm-board-tools" id="tllmBoardTools" role="toolbar" aria-label="Outils">
                    ${TOOLS.map(
                        ([id, cls, label, write]) =>
                            `<button type="button" data-tool="${id}" class="${write ? 'tllm-board-write' : ''}" aria-label="${label}" title="${label}" aria-pressed="false">${icon(cls)}</button>`
                    ).join('')}
                </div>
                <div class="tllm-board-style tllm-board-write" id="tllmBoardStyle">
                    ${COLORS.map((c) => `<button type="button" data-color="${c}" style="--c:${c}" aria-label="Couleur ${c}"></button>`).join('')}
                    <span class="tllm-board-sep"></span>
                    ${WIDTHS.map((w, i) => `<button type="button" data-width="${w}" aria-label="Épaisseur ${['fine', 'moyenne', 'large'][i]}"><span style="--w:${w + 2}px"></span></button>`).join('')}
                </div>
            </div>
            <input type="file" id="tllmBoardFile" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden>`;
        document.body.appendChild(el);

        el.querySelectorAll('[data-tool]').forEach((btn) => (btn.onclick = () => pickTool(btn.dataset.tool)));
        el.querySelectorAll('[data-color]').forEach((btn) => (btn.onclick = () => pickColor(btn.dataset.color)));
        el.querySelectorAll('[data-width]').forEach(
            (btn) => (btn.onclick = () => pickWidth(Number(btn.dataset.width)))
        );
        $('tllmBoardUndo').onclick = () => canWrite() && undo.undo();
        $('tllmBoardRedo').onclick = () => canWrite() && undo.redo();
        $('tllmBoardZoomIn').onclick = () => zoomBy(1.25);
        $('tllmBoardZoomOut').onclick = () => zoomBy(0.8);
        $('tllmBoardZoom').onclick = () => setZoom(1);
        $('tllmBoardFit').onclick = () => fit(true);
        $('tllmBoardExport').onclick = exportMenu;
        $('tllmBoardClear').onclick = clearBoard;
        $('tllmBoardClose').onclick = () => B.toggle(false);
        $('tllmBoardFile').onchange = (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) importFile(file);
        };
    }

    function buildCanvas() {
        if (B.canvas) return;
        const stage = $('tllmBoardStage');
        const canvas = new fabric.Canvas('tllmBoardCanvas', {
            width: stage.clientWidth,
            height: stage.clientHeight,
            backgroundColor: '#ffffff',
            preserveObjectStacking: true,
            fireRightClick: false,
            stopContextMenu: true,
            enableRetinaScaling: true,
        });
        B.canvas = canvas;
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
        canvas.freeDrawingBrush.decimate = 2;

        new ResizeObserver(() => {
            if (!stage.clientWidth || !stage.clientHeight) return;
            canvas.setDimensions({ width: stage.clientWidth, height: stage.clientHeight });
            canvas.calcOffset();
            renderPointers();
        }).observe(stage);

        wireCanvas(canvas);
        wireGestures(stage, canvas);
        renderAll();
    }

    // ####################################################
    // TOOLS
    // ####################################################

    const DRAW_TOOLS = new Set(['pen', 'highlighter']);
    const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'line', 'arrow']);

    function pickTool(tool) {
        B.toolChosen = true; // chosen by hand: stays, whatever the right to write does
        if (tool === 'image') {
            if (canWrite()) $('tllmBoardFile').click();
            return;
        }
        if (!canWrite() && tool !== 'hand') tool = 'hand';
        B.tool = tool;
        applyTool();
    }

    function pickColor(color) {
        B.color = color;
        const active = B.canvas?.getActiveObjects() || [];
        // Recolour the selection
        active.forEach((obj) => {
            if (obj.type === 'tllmNote') return;
            if (obj.type === 'textbox') obj.set('fill', color);
            else if (obj.type === 'path' && obj.tllmHighlight) obj.set('stroke', withAlpha(color, 0.35));
            else if (obj.type !== 'image') obj.set('stroke', color);
            commit(obj);
        });
        if (active.length) B.canvas.requestRenderAll();
        applyTool();
    }

    function pickWidth(width) {
        B.width = width;
        applyTool();
    }

    const withAlpha = (hex, alpha) => {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    };

    function applyTool() {
        const canvas = B.canvas;
        const write = canWrite();
        if (!write && B.tool !== 'hand') B.tool = 'hand';
        document.querySelectorAll('#tllmBoardTools [data-tool]').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(btn.dataset.tool === B.tool));
        });
        document.querySelectorAll('#tllmBoardStyle [data-color]').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(btn.dataset.color === B.color));
        });
        document.querySelectorAll('#tllmBoardStyle [data-width]').forEach((btn) => {
            btn.setAttribute('aria-pressed', String(Number(btn.dataset.width) === B.width));
        });
        $('tllmBoard')?.classList.toggle('tllm-board-readonly', !collab.writable);
        if (!canvas) return;
        canvas.isDrawingMode = write && DRAW_TOOLS.has(B.tool);
        if (canvas.isDrawingMode) {
            const highlight = B.tool === 'highlighter';
            canvas.freeDrawingBrush.color = highlight ? withAlpha(B.color, 0.35) : B.color;
            canvas.freeDrawingBrush.width = highlight ? B.width * 4 + 6 : B.width;
        }
        canvas.selection = write && B.tool === 'select';
        canvas.skipTargetFind = !(write && (B.tool === 'select' || B.tool === 'eraser'));
        canvas.defaultCursor =
            { hand: 'grab', eraser: 'cell', text: 'text', note: 'copy' }[B.tool] ||
            (SHAPE_TOOLS.has(B.tool) ? 'crosshair' : 'default');
        canvas.hoverCursor = B.tool === 'eraser' ? 'cell' : 'move';
        if (B.tool !== 'select') canvas.discardActiveObject();
        canvas.getObjects().forEach(applyInteractivity);
        canvas.requestRenderAll();
    }

    function applyInteractivity(obj) {
        const write = canWrite();
        obj.selectable = write && B.tool === 'select';
        obj.evented = write && (B.tool === 'select' || B.tool === 'eraser');
        if (obj.type === 'textbox' || obj.type === 'tllmNote') obj.editable = obj.selectable;
    }

    // ####################################################
    // CANVAS EVENTS
    // ####################################################

    function wireCanvas(canvas) {
        let shape = null; // shape being drawn: { obj, x, y }
        let erasing = false;
        let panning = null;
        let pointerAt = 0;
        const liveTimers = new Map();

        canvas.on('path:created', ({ path }) => {
            if (B.gesture || !canWrite()) {
                canvas.remove(path);
                return;
            }
            path.tllmHighlight = B.tool === 'highlighter';
            path.set({ strokeLineCap: 'round', strokeLineJoin: 'round' });
            commitNew(path);
        });

        canvas.on('mouse:down', (opt) => {
            const p = canvas.getPointer(opt.e);
            if (B.tool === 'hand' || opt.e.altKey) {
                panning = {
                    x: opt.e.clientX ?? opt.e.touches?.[0]?.clientX,
                    y: opt.e.clientY ?? opt.e.touches?.[0]?.clientY,
                };
                canvas.setCursor('grabbing');
                return;
            }
            if (!canWrite()) return;
            if (B.tool === 'eraser') {
                erasing = true;
                undo.stopCapturing();
                if (opt.target) eraseObject(opt.target);
                return;
            }
            if (SHAPE_TOOLS.has(B.tool)) {
                shape = { x: p.x, y: p.y, obj: makeShape(B.tool, p.x, p.y, p.x, p.y) };
                canvas.add(shape.obj);
                return;
            }
            if (B.tool === 'text' || B.tool === 'note') {
                if (opt.target) return;
                addText(B.tool, p.x, p.y);
            }
        });

        canvas.on('mouse:move', (opt) => {
            const p = canvas.getPointer(opt.e);
            if (Date.now() - pointerAt > 60) {
                pointerAt = Date.now();
                sharePointer(p);
            }
            if (panning) {
                const x = opt.e.clientX ?? opt.e.touches?.[0]?.clientX;
                const y = opt.e.clientY ?? opt.e.touches?.[0]?.clientY;
                canvas.relativePan(new fabric.Point(x - panning.x, y - panning.y));
                panning = { x, y };
                viewChanged();
                return;
            }
            if (erasing && opt.target) {
                eraseObject(opt.target);
                return;
            }
            if (shape) {
                const next = makeShape(B.tool, shape.x, shape.y, p.x, p.y);
                canvas.remove(shape.obj);
                shape.obj = next;
                canvas.add(next);
                canvas.requestRenderAll();
            }
        });

        canvas.on('mouse:up', () => {
            if (panning) {
                panning = null;
                canvas.setCursor(B.tool === 'hand' ? 'grab' : 'default');
            }
            erasing = false;
            if (shape) {
                let obj = shape.obj;
                const tiny = obj.width * obj.scaleX < 6 && obj.height * obj.scaleY < 6;
                if (tiny) {
                    // A click without dragging: a shape of a default size
                    canvas.remove(obj);
                    obj = makeShape(
                        B.tool,
                        shape.x,
                        shape.y,
                        shape.x + 160,
                        shape.y + (B.tool === 'line' || B.tool === 'arrow' ? 0 : 100)
                    );
                    canvas.add(obj);
                }
                shape = null;
                commitNew(obj);
                pickTool('select');
                canvas.setActiveObject(obj);
            }
        });

        canvas.on('mouse:out', () => sharePointer(null));

        // Moving, resizing, rotating: the others see it live (one object), and at the end
        const live = ({ target }) => {
            if (!target?.tllmId || liveTimers.has(target.tllmId)) return;
            liveTimers.set(
                target.tllmId,
                setTimeout(() => {
                    liveTimers.delete(target.tllmId);
                    commit(target);
                }, 120)
            );
        };
        canvas.on('object:moving', live);
        canvas.on('object:scaling', live);
        canvas.on('object:rotating', live);

        canvas.on('object:modified', ({ target }) => {
            if (!target) return;
            if (target.type === 'activeSelection') {
                // Objects of a selection have coordinates relative to it: put them back on the
                // board before saving them, then select them again
                const objs = target.getObjects();
                canvas.discardActiveObject();
                collab.doc.transact(() => objs.forEach((o) => o.tllmId && map.set(o.tllmId, serialize(o))), LOCAL);
                const selection = new fabric.ActiveSelection(objs, { canvas });
                canvas.setActiveObject(selection);
                canvas.requestRenderAll();
                return;
            }
            clearTimeout(liveTimers.get(target.tllmId));
            liveTimers.delete(target.tllmId);
            commit(target);
        });

        // Text: the others see it as it is typed
        let textTimer = null;
        canvas.on('text:changed', ({ target }) => {
            clearTimeout(textTimer);
            textTimer = setTimeout(() => commit(target), 250);
        });
        canvas.on('text:editing:exited', ({ target }) => {
            clearTimeout(textTimer);
            if (!target.text.trim()) removeObjects([target]);
            else commit(target);
        });

        canvas.on('selection:created', syncStyleFromSelection);
        canvas.on('selection:updated', syncStyleFromSelection);

        // Wheel: pinch on a trackpad (or Ctrl + wheel) zooms, scrolling moves the board
        canvas.on('mouse:wheel', (opt) => {
            const e = opt.e;
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                zoomAt(canvas.getZoom() * Math.pow(0.99, e.deltaY), new fabric.Point(e.offsetX, e.offsetY));
            } else {
                canvas.relativePan(new fabric.Point(-e.deltaX, -e.deltaY));
                viewChanged();
            }
        });
    }

    function syncStyleFromSelection() {
        const obj = B.canvas.getActiveObject();
        const color = obj?.type === 'textbox' ? obj.fill : obj?.stroke;
        if (typeof color === 'string' && COLORS.includes(color)) {
            B.color = color;
            applyTool();
        }
    }

    function eraseObject(obj) {
        if (obj?.tllmId) removeObjects([obj]);
    }

    function makeShape(tool, x1, y1, x2, y2) {
        const style = {
            stroke: B.color,
            strokeWidth: B.width,
            fill: 'transparent',
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            strokeUniform: true,
        };
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);
        if (tool === 'rect') return new fabric.Rect({ ...style, left, top, width: w, height: h, rx: 4, ry: 4 });
        if (tool === 'ellipse') return new fabric.Ellipse({ ...style, left, top, rx: w / 2, ry: h / 2 });
        let d = `M ${x1} ${y1} L ${x2} ${y2}`;
        if (tool === 'arrow') {
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const head = Math.max(12, B.width * 3);
            const a1 = angle + Math.PI - 0.45;
            const a2 = angle + Math.PI + 0.45;
            d += ` M ${x2 + head * Math.cos(a1)} ${y2 + head * Math.sin(a1)} L ${x2} ${y2} L ${x2 + head * Math.cos(a2)} ${y2 + head * Math.sin(a2)}`;
        }
        return new fabric.Path(d, { ...style, fill: '' });
    }

    function addText(kind, x, y) {
        const note = kind === 'note';
        const Cls = note ? fabric.TllmNote : fabric.Textbox;
        const obj = new Cls('', {
            left: x,
            top: y,
            width: note ? 200 : 260,
            fontSize: note ? 18 : 24,
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
            fill: note ? '#1f2937' : B.color,
            noteColor: note ? NOTE_COLOR : undefined,
            padding: note ? NOTE_PAD : 4,
        });
        B.canvas.add(obj);
        commitNew(obj);
        pickTool('select');
        B.canvas.setActiveObject(obj);
        obj.enterEditing();
        obj.hiddenTextarea?.focus();
    }

    // ####################################################
    // IMAGES AND PDF
    // ####################################################

    async function importFile(file) {
        if (!canWrite()) return;
        try {
            if (file.type === 'application/pdf') return await importPdf(file);
            if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type))
                return tell('Format non pris en charge', 'Images PNG, JPEG, GIF, WebP ou PDF.');
            const url = await readAsDataUrl(file);
            const src = await shrink(url, file.type === 'image/png' && file.size < 400 * 1024);
            const center = viewCenter();
            await placeImage(src, center.x, center.y);
        } catch (err) {
            console.warn('TLLM*meet board import', err);
            tell('Import impossible', 'Le fichier est illisible ou trop lourd.');
        }
    }

    const readAsDataUrl = (file) =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

    // Large pictures are reduced so the board stays light for everyone
    function shrink(url, keep) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
                if (keep && scale === 1) return resolve(url);
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * scale);
                c.height = Math.round(img.height * scale);
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, c.width, c.height);
                ctx.drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = reject;
            img.src = url;
        });
    }

    function placeImage(src, cx, cy, maxW, top = null) {
        return new Promise((resolve) => {
            fabric.Image.fromURL(src, (img) => {
                if (!img || !img.width) return resolve(null);
                const view = viewSize();
                const limit = maxW || Math.min(view.width * 0.6, view.height * 0.6 * (img.width / img.height));
                const scale = Math.min(1, limit / img.width);
                img.set({
                    scaleX: scale,
                    scaleY: scale,
                    left: cx - (img.width * scale) / 2,
                    top: top ?? cy - (img.height * scale) / 2,
                });
                B.canvas.add(img);
                commitNew(img);
                B.canvas.requestRenderAll();
                resolve(img);
            });
        });
    }

    // Each page becomes a picture; the pages are placed one below the other
    async function importPdf(file) {
        if (!window['pdfjs-dist/build/pdf'] && window.tllmLoadLib) await window.tllmLoadLib('pdfjs');
        const pdfjs = window['pdfjs-dist/build/pdf'];
        if (!pdfjs) throw new Error('pdf.js unavailable');
        pdfjs.GlobalWorkerOptions.workerSrc ||=
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const pages = Math.min(pdf.numPages, 10);
        if (pdf.numPages > 10) tell('PDF long', 'Seules les 10 premières pages sont ajoutées.');
        const center = viewCenter();
        const width = Math.min(viewSize().width * 0.7, 900);
        let top = center.y - viewSize().height * 0.35;
        undo.stopCapturing();
        for (let n = 1; n <= pages; n++) {
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(2, MAX_IMAGE_SIDE / base.width) });
            const c = document.createElement('canvas');
            c.width = Math.round(viewport.width);
            c.height = Math.round(viewport.height);
            await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
            const img = await placeImage(c.toDataURL('image/jpeg', 0.85), center.x, 0, width, top);
            if (img) top += img.height * img.scaleY + 24;
        }
    }

    // ####################################################
    // VIEW: zoom and position (personal)
    // ####################################################

    const viewSize = () => {
        const z = B.canvas.getZoom();
        return { width: B.canvas.getWidth() / z, height: B.canvas.getHeight() / z };
    };

    function viewCenter() {
        const vpt = B.canvas.viewportTransform;
        const z = B.canvas.getZoom();
        return { x: (B.canvas.getWidth() / 2 - vpt[4]) / z, y: (B.canvas.getHeight() / 2 - vpt[5]) / z };
    }

    function zoomAt(zoom, point) {
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
        B.canvas.zoomToPoint(point, zoom);
        viewChanged();
    }

    const zoomBy = (factor) =>
        zoomAt(B.canvas.getZoom() * factor, new fabric.Point(B.canvas.getWidth() / 2, B.canvas.getHeight() / 2));
    const setZoom = (zoom) => zoomAt(zoom, new fabric.Point(B.canvas.getWidth() / 2, B.canvas.getHeight() / 2));

    function contentBounds() {
        const objs = B.canvas.getObjects().filter((o) => o.tllmId);
        if (!objs.length) return null;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        objs.forEach((o) => {
            const r = o.getBoundingRect(true, true);
            left = Math.min(left, r.left);
            top = Math.min(top, r.top);
            right = Math.max(right, r.left + r.width);
            bottom = Math.max(bottom, r.top + r.height);
        });
        if (objs.some((o) => o.type === 'tllmNote')) bottom += NOTE_MIN_H;
        return { left, top, width: right - left, height: bottom - top };
    }

    // Show everything (never zoom in beyond 100 % to do it)
    function fit(byUser = false) {
        const canvas = B.canvas;
        const b = contentBounds();
        if (!b) {
            canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
            return viewChanged(byUser);
        }
        const margin = 40;
        const zoom = Math.min(
            1,
            (canvas.getWidth() - margin * 2) / b.width,
            (canvas.getHeight() - margin * 2) / b.height
        );
        const z = Math.max(ZOOM_MIN, zoom);
        canvas.setViewportTransform([
            z,
            0,
            0,
            z,
            canvas.getWidth() / 2 - (b.left + b.width / 2) * z,
            canvas.getHeight() / 2 - (b.top + b.height / 2) * z,
        ]);
        viewChanged(byUser);
    }

    function viewChanged(byUser = true) {
        if (byUser) B.viewTouched = true;
        const label = $('tllmBoardZoom');
        if (label && B.canvas) label.textContent = `${Math.round(B.canvas.getZoom() * 100)} %`;
        B.canvas?.requestRenderAll();
        renderPointers();
    }

    // Two fingers: zoom and move. Fabric never sees these touches.
    function wireGestures(stage, canvas) {
        let start = null;
        const pts = (e) => [...e.touches].slice(0, 2).map((t) => ({ x: t.clientX, y: t.clientY }));
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

        stage.addEventListener(
            'touchstart',
            (e) => {
                if (e.touches.length < 2) return;
                e.preventDefault();
                e.stopPropagation();
                B.gesture = true;
                // Cancel what the first finger started (a stroke, a move)
                if (canvas._isCurrentlyDrawing) {
                    canvas._isCurrentlyDrawing = false;
                    canvas.freeDrawingBrush._reset?.();
                    canvas.clearContext(canvas.contextTop);
                }
                canvas._currentTransform = null;
                const [a, b] = pts(e);
                start = {
                    mid: mid(a, b),
                    dist: dist(a, b),
                    zoom: canvas.getZoom(),
                    vpt: [...canvas.viewportTransform],
                };
            },
            { capture: true, passive: false }
        );
        stage.addEventListener(
            'touchmove',
            (e) => {
                if (!start || e.touches.length < 2) return;
                e.preventDefault();
                e.stopPropagation();
                const [a, b] = pts(e);
                const m = mid(a, b);
                const rect = canvas.upperCanvasEl.getBoundingClientRect();
                canvas.setViewportTransform([...start.vpt]);
                const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, start.zoom * (dist(a, b) / start.dist)));
                canvas.zoomToPoint(new fabric.Point(start.mid.x - rect.left, start.mid.y - rect.top), zoom);
                canvas.relativePan(new fabric.Point(m.x - start.mid.x, m.y - start.mid.y));
                viewChanged();
            },
            { capture: true, passive: false }
        );
        const end = (e) => {
            if (!start && !B.gesture) return;
            if (e.touches.length === 0) {
                start = null;
                setTimeout(() => (B.gesture = false), 50);
            }
            e.stopPropagation();
        };
        stage.addEventListener('touchend', end, { capture: true });
        stage.addEventListener('touchcancel', end, { capture: true });
    }

    // ####################################################
    // POINTERS OF THE OTHERS AND WHO IS HERE
    // ####################################################

    function sharePointer(p) {
        if (!B.open) return;
        collab.awareness.setLocalStateField('board', p ? { x: Math.round(p.x), y: Math.round(p.y) } : null);
    }

    function renderPointers() {
        const host = $('tllmBoardPointers');
        if (!host || !B.canvas) return;
        const vpt = B.canvas.viewportTransform;
        const seen = new Set();
        collab.awareness.getStates().forEach((state, clientId) => {
            if (clientId === collab.doc.clientID || !state?.board || !state.user) return;
            const key = `p${clientId}`;
            seen.add(key);
            let el = host.querySelector(`[data-key="${key}"]`);
            if (!el) {
                el = document.createElement('div');
                el.className = 'tllm-board-pointer';
                el.dataset.key = key;
                el.innerHTML =
                    '<span class="tllm-board-pointer-dot"></span><span class="tllm-board-pointer-name"></span>';
                host.appendChild(el);
            }
            const color = /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : '#8a94a6';
            el.style.setProperty('--c', color);
            el.querySelector('.tllm-board-pointer-name').textContent = state.user.name;
            const x = state.board.x * vpt[0] + vpt[4];
            const y = state.board.y * vpt[3] + vpt[5];
            el.style.transform = `translate(${x}px, ${y}px)`;
        });
        host.querySelectorAll('[data-key]').forEach((el) => !seen.has(el.dataset.key) && el.remove());
    }

    function renderPeople() {
        const box = $('tllmBoardPeople');
        if (!box) return;
        box.textContent = '';
        const names = new Set();
        collab.awareness.getStates().forEach((state, clientId) => {
            if (clientId === collab.doc.clientID || !state?.boardOpen || !state.user || names.has(state.user.name))
                return;
            names.add(state.user.name);
            const dot = document.createElement('span');
            dot.className = 'tllm-editor-dot';
            dot.style.background = /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : '#8a94a6';
            dot.textContent = String(state.user.name).trim().charAt(0).toUpperCase() || '?';
            dot.title = state.user.name;
            box.appendChild(dot);
        });
    }

    collab.awareness.on('change', () => {
        if (!B.open) return;
        renderPointers();
        renderPeople();
    });

    // ####################################################
    // OPEN, CLOSE, STATUS
    // ####################################################

    function updateEmpty() {
        const empty = $('tllmBoardEmpty');
        if (empty) empty.hidden = map.size > 0 || canWrite();
    }

    function refresh() {
        const status = $('tllmBoardStatus');
        if (status) {
            let text = '';
            if (!collab.connected) text = 'Connexion perdue';
            else if (!collab.synced) text = 'Chargement…';
            else if (!collab.writable) text = 'Lecture seule';
            status.textContent = text;
            status.hidden = !text;
        }
        if (canWrite() && B.tool === 'hand' && !B.toolChosen) B.tool = 'pen';
        applyTool();
        updateEmpty();
    }

    B.toggle = function (force) {
        const open = typeof force === 'boolean' ? force : !B.open;
        if (open === B.open) return;
        buildDom();
        if (open && rc?.isEditorOpen) rc.toggleEditor(); // one shared content at a time
        B.open = open;
        $('tllmBoard').hidden = !open;
        document.body.classList.toggle('tllm-board-open', open);
        window.tllmRoom?.syncLayout?.();
        collab.awareness.setLocalStateField('boardOpen', open || null);
        if (!open) {
            sharePointer(null);
            return;
        }
        requestAnimationFrame(() => {
            buildCanvas();
            const stage = $('tllmBoardStage');
            B.canvas.setDimensions({ width: stage.clientWidth, height: stage.clientHeight });
            if (!B.viewTouched) fit();
            refresh();
            renderPeople();
            renderPointers();
        });
    };

    // A presenter opened the board: open it here too, once. Closing stays personal.
    function openForEveryone() {
        if (typeof isPresenter !== 'undefined' && isPresenter && rc?.socket) {
            rc.socket.emit('whiteboardAction', { peer_name: rc.peer_name, action: 'open' });
        }
    }

    // ####################################################
    // EXPORT, CLEAR
    // ####################################################

    function snapshot() {
        const canvas = B.canvas;
        const b = contentBounds();
        if (!b) return null;
        const vpt = [...canvas.viewportTransform];
        canvas.discardActiveObject();
        canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        const margin = 24;
        const url = canvas.toDataURL({
            format: 'png',
            left: b.left - margin,
            top: b.top - margin,
            width: b.width + margin * 2,
            height: b.height + margin * 2,
            multiplier: 2,
        });
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
        return url;
    }

    const fileBase = () => {
        const room = String(rc?.room_id || 'visio').replace(/[^\w-]+/g, '-');
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `tableau-${room}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    function exportMenu() {
        if (!B.canvas || !contentBounds()) return tell('Le tableau est vide');
        Swal.fire({
            background: typeof swalBackground !== 'undefined' ? swalBackground : undefined,
            position: 'center',
            title: 'Exporter le tableau',
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: 'Image (PNG)',
            denyButtonText: 'PDF',
            cancelButtonText: 'Annuler',
        }).then((result) => {
            if (result.isConfirmed) exportPng();
            else if (result.isDenied) exportPdf();
        });
    }

    function exportPng() {
        const url = snapshot();
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileBase()}.png`;
        document.body.append(a);
        a.click();
        a.remove();
    }

    // The browser's print dialog saves it as a PDF, as for the notes
    function exportPdf() {
        const url = snapshot();
        if (!url) return;
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.append(frame);
        const doc = frame.contentDocument;
        doc.open();
        doc.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title></title>
<style>
  @page { size: auto; margin: 10mm; }
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }
  img { max-width: 100%; max-height: 100vh; object-fit: contain; }
</style></head><body></body></html>`);
        doc.close();
        doc.title = fileBase();
        const img = doc.createElement('img');
        img.alt = 'Tableau blanc';
        img.onload = () => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            setTimeout(() => frame.remove(), 60000);
        };
        img.src = url;
        doc.body.append(img);
    }

    function clearBoard() {
        if (!canWrite() || !map.size) return;
        Swal.fire({
            background: typeof swalBackground !== 'undefined' ? swalBackground : undefined,
            position: 'center',
            title: 'Tout effacer ?',
            text: 'Le tableau se vide pour tout le monde. Vous pourrez annuler.',
            showCancelButton: true,
            confirmButtonText: 'Tout effacer',
            cancelButtonText: 'Garder',
            customClass: { confirmButton: 'swal-destructive' },
        }).then((result) => {
            if (!result.isConfirmed) return;
            undo.stopCapturing();
            collab.doc.transact(() => Array.from(map.keys()).forEach((id) => map.delete(id)), LOCAL);
            B.objects.forEach((obj) => B.canvas.remove(obj));
            B.objects.clear();
            B.canvas.discardActiveObject();
            B.canvas.requestRenderAll();
            updateEmpty();
        });
    }

    // ####################################################
    // KEYBOARD: only when the board is open and nothing else has the focus
    // ####################################################

    document.addEventListener('keydown', (e) => {
        if (!B.open || !B.canvas) return;
        if (isTyping(e)) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === 'z' && !e.shiftKey) {
            if (canWrite()) undo.undo();
        } else if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
            if (canWrite()) undo.redo();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            const active = B.canvas.getActiveObjects();
            if (!active.length) return;
            removeObjects(active);
        } else if (e.key === 'Escape') {
            B.canvas.discardActiveObject();
            B.canvas.requestRenderAll();
        } else return;
        e.preventDefault();
    });
    // Typing in the chat, the notes, a form or a text of the board
    function isTyping(e) {
        if (B.canvas?.getActiveObject()?.isEditing) return true;
        const el = e.target;
        if (!el) return false;
        return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    }

    // ####################################################
    // MIROTALK WHITEBOARD: switched off, its entry points open this board
    // ####################################################

    /* eslint-disable no-global-assign */
    toggleWhiteboard = function () {
        const opening = !B.open;
        B.toggle();
        if (opening) openForEveryone();
    };
    wbUpdate = function () {};
    JsonToWbCanvas = function () {};
    handleWhiteboardObject = function () {};
    handleWhiteboardPointer = function () {};
    whiteboardAction = function (data, emit = true) {
        // From a presenter, through the server
        if (!emit && data?.action === 'open' && !B.open) B.toggle(true);
    };
    /* eslint-enable no-global-assign */

    collab.on('synced', () => {
        refresh();
        if (map.size && !B.open) tell('Un tableau blanc est en cours', 'Retrouvez-le dans le menu Plus.');
    });
    collab.on('writable', refresh);
    collab.on('connection', refresh);
})();
