// BirdWatchAI Classroom — drag the classes (or children) into your own order
//
// Asked for 2026-11-18. The list on the left used to be newest first,
// always. Now each row has a grip (⠿) to drag it up or down, by mouse or by
// finger, and the arrow keys move it when the grip has focus. The order is
// saved on the server (classroom_set_order, setup-classroom-order.sql), so
// it is the same on every device, and classroom_list returns it.
//
// Pointer events rather than HTML5 drag-and-drop: the native kind does not
// work with a finger on phones and tablets, which is exactly where a parent
// is most likely to be doing this.

function clOrderHandleHtml(room) {
    return `<span class="cl-handle" tabindex="0" role="button"
        aria-label="Move ${esc(room.name)}: drag, or press the up and down arrow keys"
        title="Drag to reorder">⠿</span>`;
}

let clOrderDrag = null;

function clOrderInit() {
    const box = document.getElementById('cl-sortable');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.addEventListener('pointerdown', clOrderDown);
    box.addEventListener('keydown', clOrderKey);
}

function clOrderDown(e) {
    const handle = e.target.closest('.cl-handle');
    if (!handle) return;
    const item = handle.closest('.cl-sort-item');
    if (!item) return;
    e.preventDefault();
    item.classList.add('cl-dragging');
    clOrderDrag = { item, handle, before: clOrderIds() };
    // On the document, not captured on the handle: moving the row in the
    // page releases a pointer capture, which stopped a drag after one step.
    document.addEventListener('pointermove', clOrderMove);
    document.addEventListener('pointerup', clOrderUp);
    document.addEventListener('pointercancel', clOrderUp);
}

function clOrderMove(e) {
    const d = clOrderDrag;
    if (!d) return;
    e.preventDefault();
    const box = d.item.parentNode;
    const others = [...box.querySelectorAll('.cl-sort-item')].filter(x => x !== d.item);
    // The first row whose middle is below the pointer is the one to go in
    // front of; none means the end of the list.
    const next = others.find(x => {
        const r = x.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
    });
    if (next) { if (next !== d.item.nextElementSibling) box.insertBefore(d.item, next); }
    else if (d.item !== box.lastElementChild) box.appendChild(d.item);
}

function clOrderUp() {
    const d = clOrderDrag;
    clOrderDrag = null;
    document.removeEventListener('pointermove', clOrderMove);
    document.removeEventListener('pointerup', clOrderUp);
    document.removeEventListener('pointercancel', clOrderUp);
    if (!d) return;
    d.item.classList.remove('cl-dragging');
    if (clOrderIds().join() !== d.before.join()) clOrderSave();
}

function clOrderKey(e) {
    const handle = e.target.closest('.cl-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const item = handle.closest('.cl-sort-item');
    const box = item.parentNode;
    if (e.key === 'ArrowUp' && item.previousElementSibling) box.insertBefore(item, item.previousElementSibling);
    else if (e.key === 'ArrowDown' && item.nextElementSibling) box.insertBefore(item.nextElementSibling, item);
    else return;
    handle.focus();
    // A burst of key presses is one move, saved once.
    clearTimeout(clOrderKey.t);
    clOrderKey.t = setTimeout(clOrderSave, 600);
}

function clOrderIds() {
    return [...document.querySelectorAll('#cl-sortable .cl-sort-item')].map(x => x.dataset.room);
}

async function clOrderSave() {
    const ids = clOrderIds();
    if (!ids.length) return;
    // The local list follows at once, so a redraw before the server answers
    // does not snap the rows back.
    const byId = new Map(classroomList.map(r => [r.id, r]));
    const moved = ids.map(id => byId.get(id)).filter(Boolean);
    classroomList = moved.concat(classroomList.filter(r => !ids.includes(r.id)));
    const { error } = await sbRpc('classroom_set_order', { p_classroom_ids: ids }, true);
    if (error) {
        showToast(error.message || 'Could not save the new order.');
        if (typeof refreshClassroomPanel === 'function') refreshClassroomPanel();
        return;
    }
    showToast('Order saved.');
}
