import { mount } from 'svelte';
import App from './App.svelte';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.min.css';

const target = document.getElementById('app');
if (target) mount(App, { target });
