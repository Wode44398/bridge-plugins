// 插件页面入口：等 SDK 和宿主握手（主题、语言）、读回偏好，再挂界面。
import { mount } from 'svelte';
import App from './App.svelte';
import { ready, prefs } from './lib/host.js';
import './page.css';

await ready;
await prefs.load(['bridge-android-serial', 'bridge-android-sub']);
mount(App, { target: document.getElementById('app') });
