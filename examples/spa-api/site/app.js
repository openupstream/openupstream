// The spa-api demo's single-page app: plain DOM, no build step. Two views,
// the list at / and one file at /files/<name>; a deep link to the second
// works through the Route's SPA fallback, which serves index.html for it.
const view = document.getElementById('view');

const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

const link = (href, text) => el('a', { href }, text);

const api = async (path, init) => {
    const response = await fetch(`/api${path}`, init);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `the API answered ${response.status}`);
    }
    return response;
};

const alert = (error) => el('p', { role: 'alert' }, error.message);

async function listView() {
    const input = el('input', { type: 'file', required: true });
    const form = el('form', {}, input, el('button', {}, 'Upload'), el('small', {}, ' up to 1 MiB'));
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = input.files[0];
        const name = file.name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[._-]+/, '').slice(0, 100) || 'file';
        await api(`/files/${encodeURIComponent(name)}`, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } })
            .then(() => navigate('/'))
            .catch((error) => form.after(alert(error)));
    });
    const files = await (await api('/files')).json();
    const list = files.length === 0
        ? el('p', {}, 'No files yet.')
        : el('ul', {}, ...files.map((file) => el('li', {}, link(`/files/${encodeURIComponent(file.name)}`, file.name), ' ', el('small', {}, `${file.size} bytes, `), el('time', { dateTime: file.lastModified }, file.lastModified))));
    return [form, list];
}

async function fileView(name) {
    const url = `/api/files/${encodeURIComponent(name)}`;
    const response = await api(`/files/${encodeURIComponent(name)}`);
    const type = response.headers.get('content-type') ?? '';
    const preview = type.startsWith('image/')
        ? el('img', { src: url, alt: name })
        : type.startsWith('text/') || type === 'application/json'
            ? el('pre', {}, await response.text())
            : el('p', {}, `${type}, no preview`);
    const remove = el('button', {}, 'Delete');
    remove.addEventListener('click', () => api(`/files/${encodeURIComponent(name)}`, { method: 'DELETE' }).then(() => navigate('/')).catch((error) => remove.after(alert(error))));
    return [el('h2', {}, name), preview, el('p', {}, link(url, 'Download'), ' ', remove), el('p', {}, link('/', 'All files'))];
}

async function render() {
    const match = /^\/files\/([^/]+)$/.exec(location.pathname);
    const children = await (match === null ? listView() : fileView(decodeURIComponent(match[1]))).catch((error) => [alert(error), el('p', {}, link('/', 'All files'))]);
    view.replaceChildren(...children);
}

function navigate(path) {
    history.pushState(null, '', path);
    return render();
}

// Links within the app change the view without loading the page; downloads from the API load as usual.
document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (anchor === null || anchor.origin !== location.origin || anchor.pathname.startsWith('/api/') || event.metaKey || event.ctrlKey) {
        return;
    }
    event.preventDefault();
    void navigate(anchor.pathname);
});
addEventListener('popstate', () => void render());
void render();
