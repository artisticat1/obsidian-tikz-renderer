import {App, MarkdownPostProcessorContext, Plugin, PluginSettingTab, Setting} from 'obsidian';

import * as fs from 'fs';
import * as path from 'path';
import {exec, ExecException} from 'child_process';
import * as temp from 'temp';
// import {keymap} from '@codemirror/view';
// import {basicSetup, EditorState, EditorView} from "@codemirror/basic-setup";
// import {indentWithTab} from "@codemirror/commands"
import ErrnoException = NodeJS.ErrnoException;

// import {tex} from "@codemirror/lang-tex";

import { optimize } from "./svgo.browser";


interface PluginSettings {
	latexCommand: string;
	defaultRenderMode: string;
	preamble: string;
	timeout: number;
}

const OBSIDIAN_LOGO = "\\definecolor{c1}{HTML}{34208c}\n" +
	"\\definecolor{c2}{HTML}{af9ff4}\n" +
	"\\definecolor{c3}{HTML}{4a37a0}\n" +
	"\\definecolor{c4}{HTML}{af9ff4}\n" +
	"\\definecolor{g1}{HTML}{6c56cc}\n" +
	"\\definecolor{g2}{HTML}{9785e5}\n" +
	"\\tikzset{every path/.style={rounded corners=0.2}}\n" +
	"\n" +
	"\\draw[fill=c1] (0.4461,0) -- (0.1291, -0.1752) -- (0, -0.4545) -- (0.1957, -0.9047) -- (0.4735, -1) -- (0.5244, -0.898) -- (0.63, -0.2639) -- cycle;\n" +
	"\\draw[fill=c2] (0.63, -0.2639) -- (0.4461, 0) -- (0.4344, -0.1441) -- cycle;\n" +
	"\\draw[fill=c4] (0.1643, -0.357) -- (0.1957, -0.9047) -- (0.4735, -1) -- cycle;\n" +
	"\\draw[left color=g1, right color=g2] (0.63, -0.2639) -- (0.4344, -0.1441) -- (0.1643, -0.357) -- (0.4735, -1.00) -- (0.5244, -0.898) --  cycle;\n" +
	"\\draw[fill=c3] (0.4344, -0.1441) -- (0.4461, 0) --  (0.1291, -0.1752) -- (0.1643, -0.357) -- cycle;"

const DEFAULT_SETTINGS: PluginSettings = {
	latexCommand: 'pdflatex -interaction=nonstopmode -halt-on-error -shell-escape "{input}" && pdf2svg input.pdf "{output}"',
	defaultRenderMode: "image_only",
	preamble: "% Put any LaTeX commands here, e.g., \\usetikzlibrary{calc}, \\usepackage{xcolor} or \\tikzset{...}",
	timeout: 10000,	// 10s
}

function formatError(err: any) {
	let html = '<div>'
	if (err.signal === 'SIGTERM') {
		html += 'Child process got terminated. Is the timeout large enough?'
	} else {
		html += err.toString();
	}
	html += '</div>'
	return html
}

export default class MyPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor('tikzpicture', (source,el, ctx) => {
			// Skip empty code blocks
			if (!source) return;

			el.innerHTML = '<div class="tikz-preview-rendering">Rendering...</div>';

			this.renderTikz2SVG(source).then(async (data: string) => {

				let svg = this.colorSVGinDarkMode(data);
				svg = await this.optimizeSVG(svg);

				el.innerHTML = svg;

			}).catch((err) => {
				// console.log(err);
				el.innerText = err;
			});
		});


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	renderTikz2SVG(source: string) {

		// Build latex source code with standalone class
// 		const latex_source = `\\documentclass[tikz]{standalone}
// ${this.settings.preamble}
// \\begin{document}
// \\begin{tikzpicture}
//   ${source}
// \\end{tikzpicture}
// \\end{document}`;

		// Render latex
		return this.renderLatex2SVG(source);
	}

	renderTikzToContainer(source: string, container: HTMLElement) {
		return new Promise<void>((resolve, reject) => {
			this.renderTikz2SVG(source).then((data: string) => {
				container.innerHTML = data;
				resolve();
			}).catch(err => {
				container.innerHTML = formatError(err);
				reject(err);
			});
		})
	}

	renderLatex2SVG(source: string) {
		// Build latex:
		//  - create temp folder
		// 	- write file to temp folder
		//	- call pdflatex and pdf2svg
		// 	- load svg file
		return new Promise((resolve, reject) => {
			temp.mkdir('obsidian-tikz', (err: ErrnoException | null, dirPath: string) => {
				const inputPath = path.join(dirPath, 'input.tex')
				fs.writeFile(inputPath, source, (err: ErrnoException | null) => {
					if (err) reject(err);
					const command = this.settings.latexCommand
						.replace('{input}', 'input.tex')
						.replace('{output}', 'output.svg');

					exec(command, {cwd: dirPath, timeout: this.settings.timeout}, (err: ExecException | null) => {
						if (err) reject(err);
						fs.readFile(path.join(dirPath, 'output.svg'), function (err: ErrnoException | null, data: Buffer) {
							if (err) reject(err)
							resolve(data.toString());
						});
					});
				});
			})
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	
	colorSVGinDarkMode(svg: string) {
		// Replace the color "black" with currentColor (the current text color)
		// so that diagram axes, etc are visible in dark mode
		// And replace "white" with the background color

		svg = svg.replaceAll(/rgb\(0%,0%,0%\)/g, `currentColor`)
				.replaceAll(/rgb\(100%,100%,100%\)/g, `var(--background-primary)`);

		return svg;
	}


	async digestMessage(text: string) {
		const textAsBuffer = new TextEncoder().encode(text);
		const hashBuffer = await window.crypto.subtle.digest('SHA-256', textAsBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer))
		const digest = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

		return digest
	}


	async optimizeSVG(svg: string) {
		// Optimize the svg using SVGO
		// We replace IDs in the svg to avoid conflicts across multiple images, leading to errors in the rendering
		
		// Use the "prefixIds" plugin to do this
		// Each svg uses its own unique prefix, given by a hash
		
		const prefix = await this.digestMessage(svg);

		return optimize(svg, {plugins:
			[
				'preset-default',
				{
					name: 'prefixIds',
					params: {
					prefix: prefix,
					},
				},
			]
		// @ts-ignore
		}).data;
	}

}

class SettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Settings for tikz renderer'});

		/*
		 * LaTeX Command
		 */
		// This seems hacky, but I don't know a better way to get the text input below the name & description
		const latexCommandText = new Setting(containerEl)
			.setName('LaTeX command')
			.setDesc('Command executed to render latex to svg')
			.settingEl.parentElement.createEl('input', {type: 'text'})
		latexCommandText.addClass('tikz-preview-settings-latex-command')
		latexCommandText.value = this.plugin.settings.latexCommand;
		latexCommandText.onchange = async () => {
			this.plugin.settings.latexCommand = latexCommandText.value;
			await this.plugin.saveSettings();
		}

		/*
		 * Render mode
		 */
		new Setting(containerEl)
			.setName("Default Render Mode")
			.setDesc("Render Mode. You might have to refresh the rendered output for this to have an effect.")
			.addDropdown(dropdown => dropdown
				.addOption("side_by_side", "side by side")
				.addOption("image_only", "image only")
				.setValue(this.plugin.settings.defaultRenderMode)
				.onChange(async value => {
					this.plugin.settings.defaultRenderMode = value;
					await this.plugin.saveSettings();
				}));

		/*
		 * Preamble
		 * TODO: How do I enable syntax highlighting for LaTeX?
		 * TODO: Maybe: Only save settings when editor focus is lost (I don't know how)
		 */
		const preambleSetting = new Setting(containerEl)
			.setName("Preamble")
			.setDesc(
				"Preamble used for rendering with LaTeX. Can be used to load latex packages or tikz libraries, " +
				"or to define tikz styles that are available in all tikz code blocks."
			)

		// new EditorView({
		// 	state: EditorState.create({
		// 		doc: this.plugin.settings.preamble,
		// 		extensions: [
		// 			basicSetup,
		// 			keymap.of([indentWithTab]),
		// 			EditorView.updateListener.of(async update => {
		// 				console.log('editor updated', update.state.doc.toString(), update)
		// 				this.plugin.settings.preamble = update.state.doc.toString();
		// 				await this.plugin.saveSettings();
		// 			})
		// 		],
		// 	}),
		// 	parent: preambleSetting.settingEl.parentElement
		// })

		/*
		 * Timeout
		 */
		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("Timeout for one LaTeX render call, in ms.")
			.addText(text => text
				.setValue(this.plugin.settings.timeout.toString())
				.onChange(async (value) => {
					const parsedValue = parseInt(value);
					if (parsedValue === undefined) return;
					this.plugin.settings.timeout = parsedValue;
					await this.plugin.saveSettings();
				}))

		/*
		 * Test
		 */
		const s = new Setting(containerEl)
			.setName("Test Settings!")
			.setDesc("This test renders the Obsidian Logo as tikz to check if the configuration works and LaTeX is " +
				"available on the system.");
		const outcontainer = s.settingEl.parentElement.createEl('div');
		outcontainer.innerText = 'Click "TestSettings" to render test image...';
		outcontainer.addClass('tikz-preview-test');
		s.addButton(button => button
				.setButtonText("Test Settings")
				.onClick(() => {
					console.log('Testing tikz renderer settings')
					outcontainer.removeClasses(['tikz-preview-test-ok', 'tikz-preview-test-failed'])
					outcontainer.innerText = "Rendering tikz..."
					this.plugin.renderTikzToContainer(OBSIDIAN_LOGO, outcontainer).then(() => {
						outcontainer.addClass('tikz-preview-test-ok');
					}).catch(() => {
						outcontainer.addClass('tikz-preview-test-failed');
					});
				}));
	}
}
