import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync('app/src/main/assets/index.html', 'utf8');
const virtualConsole = new VirtualConsole();
const runtimeErrors = [];
virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.message));

const dom = new JSDOM(html, {
  url: 'https://dashboard.test/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;
const { document } = window;

assert.equal(typeof window.showModal, 'function', 'modal open function is globally callable');
assert.equal(typeof window.hideModal, 'function', 'modal close function is globally callable');
assert.equal(typeof window.toggleNotifPanel, 'function', 'notification toggle is globally callable');
assert.equal(typeof window.closeNotifPanel, 'function', 'notification close is globally callable');

const aboutButton = document.getElementById('btnAboutApp');
const aboutModal = document.getElementById('aboutModal');
assert.ok(aboutButton && aboutModal, 'About button and modal exist');
aboutButton.click();
assert.ok(aboutModal.classList.contains('show'), 'About opens');
assert.equal(aboutModal.style.display, 'flex', 'About is visible');
assert.ok(document.body.classList.contains('modal-open'), 'background lock is enabled');

aboutModal.querySelector('.modal-content').dispatchEvent(
  new window.MouseEvent('click', { bubbles: true })
);
assert.ok(aboutModal.classList.contains('show'), 'clicking inside About does not close it');

aboutModal.querySelector('.btn-close').click();
assert.ok(!aboutModal.classList.contains('show'), 'About close button closes it');
assert.ok(!document.body.classList.contains('modal-open'), 'background lock is released');

const bell = document.getElementById('btnBell');
const panel = document.getElementById('notifPanel');
const overlay = document.getElementById('notifOverlay');
assert.ok(bell && panel && overlay, 'bell, panel, and overlay exist');
bell.click();
assert.equal(panel.style.display, 'flex', 'bell opens notifications');
assert.ok(overlay.classList.contains('open'), 'notification overlay opens');
bell.click();
assert.equal(panel.style.display, 'none', 'bell closes notifications on second click');
assert.ok(!overlay.classList.contains('open'), 'notification overlay closes');

bell.click();
overlay.click();
assert.equal(panel.style.display, 'none', 'outside click closes notifications');

const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>', styleStart);
const css = html.slice(styleStart, styleEnd);
assert.ok(css.includes('.notif-overlay{position:fixed;inset:0;z-index:9800;display:none}'),
  'notification overlay stays below the top bar');
const modalRuleStart = css.indexOf('.modal {');
const modalRuleEnd = css.indexOf('.modal.show', modalRuleStart);
assert.ok(modalRuleStart >= 0 && modalRuleEnd > modalRuleStart, 'custom modal CSS rule exists');
assert.ok(!css.slice(modalRuleStart, modalRuleEnd).includes('backdrop-filter'),
  'modal does not apply full-screen GPU blur');
assert.ok(css.includes('body.modal-open .main-app') && css.includes('pointer-events: none !important'),
  'background interaction is locked');
assert.ok(css.includes('body.modal-open .modal') && css.includes('pointer-events: auto'),
  'modal interaction remains enabled');

dom.window.close();
console.log('Behavioral UI checks passed: About open/close, background lock release, bell open/toggle-close/outside-close.');
if (runtimeErrors.length) {
  console.warn('jsdom reported non-fatal page startup errors:', runtimeErrors.slice(0, 3));
}
