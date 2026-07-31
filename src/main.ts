import { App, HELP_HTML } from './ui/app';

const helpBody = document.getElementById('help-body');
if (helpBody) helpBody.innerHTML = HELP_HTML;

new App();
