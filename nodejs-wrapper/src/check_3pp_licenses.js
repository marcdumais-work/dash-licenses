#!/usr/bin/env node
// *****************************************************************************
// Copyright (C) 2021-2023 Ericsson and others
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
// @ts-check

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const NO_COLOR = Boolean(process.env['NO_COLOR']);
const dashLicensesJar = path.resolve(__dirname, 'download/dash-licenses.jar');
const dashLicensesDownloadUrl = 'https://repo.eclipse.org/service/local/artifact/maven/redirect?r=dash-licenses&g=org.eclipse.dash&a=org.eclipse.dash.licenses&v=LATEST';
const dashLicensesInternalError = 127;

const dashParams = [
    "batch",
    "project",
    "review",
    "summary",
    "timeout",
];


// to extract CLI parameters
const projectNameRegexp = /--project=(\S+).*/;
const depsInputFileRegexp = /--inputFile=(\S+).*/;
const configFileRegexp = /--config=(\S+).*/;
const exclusionsRegexp = /--exclusions=(\S+).*/;

// CLI parameters accepted by the script, and corresponding 
// Regexp to parse tje,
const wrapperCLI = {
    "project": /--project=(\S+).*/,
    "inputFile": /--inputFile=(\S+).*/,
    "config": /--config=(\S+).*/,
    "exclusions": /--exclusions=(\S+).*/,
    "dryRun": /--dryRun/,
    "review": /--review/
};

// default for configurable parameters
// Note: We do not handle the Gitlab token. Instead, an environment variable should be used. dash-licenses 
// will use it directly from there.
const dashLicensesConfig = {
    // default config file, to fine-tune dash-licenses options
    "externalConfig": "dashLicensesConfig.json",
    // Eclipse Foundation project name. e.g. "ecd.theia", "ecd.cdt-cloud"
    "project": "none",
    // Use dash-license "review" mode, to automatically create IP tickets for any suspicious dependencies? 
    "review": false,
    // File where dependencies are defined. Passed as-it to dash-licenses
    "dependencyFile": "yarn.lock",
    // Batch size. Passed as-it to dash-licenses
    "batch": 50,
    // Timeout. Passed as-it to dash-licenses
    "timeout": 240,
    // File where exclusions are defined. Any excluded dependency will not cause
    // this wrapper to exit with an error status (on its own) or be reported in
    // the post-run status as requiring more scrutiny
    "exclusions": "dependency-check-baseline.json",
    // Summary file, in which dash-licenses will save its findings
    "summary": "dependency-check-summary.txt"
};



// Before proceeding, we need to check whether there's a CLI option used 
// to point us to a non-default config file
const configCLI = process.argv.find(arg => configFileRegexp.exec(arg));
if (configCLI) {
     const cfg = configCLI.replace(configFileRegexp, '$1');
     if (fs.existsSync(cfg)) {
        dashLicensesConfig["externalConfig"] = cfg;
     } else {
        warn(`Config file provided on CLI does not exist: "${cfg}" - ignoring`);
     }
}

// config file to use
const configFile = dashLicensesConfig["externalConfig"];


// config file, potentially present in the workspace
const dashLicensesWorkspaceConfig = path.resolve(configFile);
if (fs.existsSync(dashLicensesWorkspaceConfig)) {
    const wsConfig = JSON.parse(fs.readFileSync(dashLicensesWorkspaceConfig, 'utf8'));
    // prefer config file entries vs defaults
    const wsConfigKeys = Object.keys(wsConfig);
    wsConfigKeys.map(k => {
        const value = wsConfig[k];
        // only consider known parameters
        if(Object.keys(dashLicensesConfig).includes(k)) {
            // exclude undefined values and also empty or white-space strings
            if (value !== undefined && (typeof value != 'string' || value.trim() != "")) {
                dashLicensesConfig[k] = wsConfig[k];    
            } else {
                warn(`(${path.basename(dashLicensesWorkspaceConfig)}) - config file entry "${k}" is undefined - ignoring it`); 
            }
        }
    });
}

// CLI parameters have highest priority - use any passed this way over default 
// or config file values
if (process.argv.includes('--review')) {
    dashLicensesConfig["review"] = true;    
}

const projectNameCLI = process.argv.find(arg => projectNameRegexp.exec(arg));
if (projectNameCLI) {
    dashLicensesConfig["project"] = projectNameCLI.replace(projectNameRegexp, '$1');
}

const depFileCLI = process.argv.find(arg => depsInputFileRegexp.exec(arg));
if (depFileCLI) {
    dashLicensesConfig["dependencyFile"] = depFileCLI.replace(depsInputFileRegexp, '$1');
}

const exclusionsCLI = process.argv.find(arg => exclusionsRegexp.exec(arg));
if (exclusionsCLI) {
    dashLicensesConfig["exclusions"] = exclusionsCLI.replace(exclusionsRegexp, '$1');
}

function parseCLI() {
    Object.keys(dashLicensesConfig).map(k => {
        info(`${k} -> ${dashLicensesConfig[k]}`);
    });
}

info("Effective configuration: ");
info("-------------------------------------");
Object.keys(dashLicensesConfig).map(k => {
    info(`${k} -> ${dashLicensesConfig[k]}`);
});
info("-------------------------------------");

// review mode has further requirements that may force us to reconsider
let autoReviewMode = dashLicensesConfig["review"];
const projectName = dashLicensesConfig["project"]
const depsInputFile = dashLicensesConfig["dependencyFile"]

// The following are not at this time configurable through the CLI:
const dashLicensesExclusionsFile = dashLicensesConfig["exclusions"];
const dashLicensesSummary = path.resolve(dashLicensesConfig["summary"]);

// A Eclipse Foundation Gitlab Personal Access Token, generated by an Eclipse committer,
// is required to use dash-licenses in "review" mode. For more information see:
// https://github.com/eclipse/dash-licenses#automatic-ip-team-review-requests and 
// https://github.com/eclipse/dash-licenses/issues/186#issuecomment-1324498399
//
// e.g. Set the token like so (bash shell):
// $> export DASH_TOKEN=<your_token>
//
// Since dash-licenses can consume the PAT directly from the environment. Let's just
// confirm whether that's set or not
const personalAccessTokenIsSet = "DASH_TOKEN" in process.env;

main().catch(error => {
    console.error(error);
    process.exit(1);
});

async function main() {
    if (!fs.existsSync(depsInputFile)) {
        error(`Input file not found: ${depsInputFile}. Please provide it using "--inputFile=" CLI option`);
        process.exit(1);
    }
    info('Using input file: ' + depsInputFile);
    if (autoReviewMode && !personalAccessTokenIsSet) {
        warn('Please setup an Eclipse Foundation Gitlab Personal Access Token to run the license check in "review" mode');
        warn('It should be set in an environment variable named "DASH_TOKEN"');
        warn('Proceeding in normal mode since the PAT is not currently set');
        autoReviewMode = false;
    }
    if (autoReviewMode && !projectName) {
        warn('Please provide a valid Eclipse Foundation project name to run the license check in "review" mode');
        warn('You can pass it using the "--project=" CLI parameter');
        warn('Proceeding in normal (non-review) mode since the PAT is not currently set');
        autoReviewMode = false;
    }
    if (!fs.existsSync(dashLicensesJar)) {
        info('Fetching dash-licenses...');
        fs.mkdirSync(path.dirname(dashLicensesJar), { recursive: true });
        const curlError = getErrorFromStatus(spawn(
            'curl', ['-L', dashLicensesDownloadUrl, '-o', dashLicensesJar],
        ));
        if (curlError) {
            error(curlError);
            process.exit(1);
        }
    }
    if (fs.existsSync(dashLicensesSummary)) {
        info('Backing up previous summary...');
        fs.renameSync(dashLicensesSummary, `${dashLicensesSummary}.old`);
    }
    info('Running dash-licenses...');
    const args = ['-jar', dashLicensesJar, depsInputFile, '-batch', '50', '-timeout', '240', '-summary', dashLicensesSummary];
    if (autoReviewMode && personalAccessTokenIsSet && projectName) {
        info(`Using "review" mode for project: ${projectName}`);
        args.push('-review', '-project', projectName);
    }
    const dashStatus = spawn('java', args, {
        stdio: ['ignore', 'inherit', 'inherit']
    });

    const dashError = getErrorFromStatus(dashStatus);

    if (dashError) {
        if (dashStatus.status == dashLicensesInternalError) {
            error(dashError);
            error('Detected an internal error in dash-licenses - run inconclusive');
            process.exit(dashLicensesInternalError);
        }
        warn(dashError);
    }

    const restricted = await getRestrictedDependenciesFromSummary(dashLicensesSummary);
    if (restricted.length > 0) {
        if (fs.existsSync(dashLicensesExclusionsFile)) {
            info('Checking results against the baseline...');
            const baseline = readBaseline(dashLicensesExclusionsFile);
            const unmatched = new Set(baseline.keys());
            const unhandled = restricted.filter(entry => {
                unmatched.delete(entry.dependency);
                return !baseline.has(entry.dependency);
            });
            if (unmatched.size > 0) {
                warn('Some entries in the baseline did not match anything from dash-licenses output:');
                for (const dependency of unmatched) {
                    console.log(magenta(`> ${dependency}`));
                    const data = baseline.get(dependency);
                    if (data) {
                        console.warn(`${dependency}:`, data);
                    }
                }
            }
            if (unhandled.length > 0) {
                error(`Found results that aren't part of the baseline!`);
                logRestrictedDashSummaryEntries(unhandled);
                process.exit(1);
            }
        } else {
            error(`Found unhandled restricted dependencies!`);
            logRestrictedDashSummaryEntries(restricted);
            process.exit(1);
        }
    }
    info('Done.');
    process.exit(0);
}

/**
 * @param {Iterable<DashSummaryEntry>} entries
 * @return {void}
 */
function logRestrictedDashSummaryEntries(entries) {
    for (const { dependency: entry, license } of entries) {
        console.log(red(`X ${entry}, ${license}`));
    }
}

/**
 * @param {string} summary path to the summary file.
 * @returns {Promise<DashSummaryEntry[]>} list of restricted dependencies.
 */
async function getRestrictedDependenciesFromSummary(summary) {
    const restricted = [];
    for await (const entry of readSummaryLines(summary)) {
        if (entry.status.toLocaleLowerCase() === 'restricted') {
            restricted.push(entry);
        }
    }
    return restricted.sort(
        (a, b) => a.dependency.localeCompare(b.dependency)
    );
}

/**
 * Read each entry from dash's summary file and collect each entry.
 * This is essentially a cheap CSV parser.
 * @param {string} summary path to the summary file.
 * @returns {AsyncIterableIterator<DashSummaryEntry>} reading completed.
 */
async function* readSummaryLines(summary) {
    for await (const line of readline.createInterface(fs.createReadStream(summary))) {
        const [dependency, license, status, source] = line.split(', ');
        yield { dependency, license, status, source };
    }
}

/**
 * Handle both list and object format for the baseline json file.
 * @param {string} baseline path to the baseline json file.
 * @returns {Map<string, any>} map of dependencies to ignore if restricted, value is an optional data field.
 */
function readBaseline(baseline) {
    const json = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    if (Array.isArray(json)) {
        return new Map(json.map(element => [element, null]));
    } else if (typeof json === 'object' && json !== null) {
        return new Map(Object.entries(json));
    }
    console.error(`ERROR: Invalid format for "${baseline}"`);
    process.exit(1);
}

/**
 * Spawn a process. Exits with code 1 on spawn error (e.g. file not found).
 * @param {string} bin
 * @param {(string | object)[]} args
 * @param {import('child_process').SpawnSyncOptions} [opts]
 * @returns {import('child_process').SpawnSyncReturns}
 */
function spawn(bin, args, opts = {}) {
    opts = { stdio: 'inherit', ...opts };
    function abort(spawnError, spawnBin, spawnArgs) {
        if (spawnBin && spawnArgs) {
            error(`Command: ${prettyCommand({ bin: spawnBin, args: spawnArgs })}`);
        }
        error(spawnError.stack ?? spawnError.message);
        process.exit(1);
    }
    /** @type {any} */
    let status;
    try {
        status = cp.spawnSync(bin, args, opts);
    } catch (spawnError) {
        abort(spawnError, bin, args);
    }
    // Add useful fields to the returned status object:
    status.bin = bin;
    status.args = args;
    status.opts = opts;
    // Abort on spawn error:
    if (status.error) {
        abort(status.error, status.bin, status.args);
    }
    return status;
}

/**
 * @param {import('child_process').SpawnSyncReturns} status
 * @returns {string | undefined} Error message if the process errored, `undefined` otherwise.
 */
function getErrorFromStatus(status) {
    if (typeof status.signal === 'string') {
        return `Command ${prettyCommand(status)} exited with signal: ${status.signal}`;
    } else if (status.status !== 0) {
        if (status.status == dashLicensesInternalError) {
            return `Command ${prettyCommand(status)} exit code (${status.status}) means dash-licenses has encountered an internal error`;
        }
        return `Command ${prettyCommand(status)} exited with code: ${status.status}`;
    }
}

/**
 * @param {any} status
 * @param {number} [indent]
 * @returns {string} Pretty command with both bin and args as stringified JSON.
 */
function prettyCommand(status, indent = 2) {
    return JSON.stringify([status.bin, ...status.args], undefined, indent);
}

function info(text) { console.warn(cyan(`INFO: ${text}`)); }
function warn(text) { console.warn(yellow(`WARN: ${text}`)); }
function error(text) { console.error(red(`ERROR: ${text}`)); }

function style(code, text) { return NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`; }
function cyan(text) { return style(96, text); }
function magenta(text) { return style(95, text); }
function yellow(text) { return style(93, text); }
function red(text) { return style(91, text); }

/**
 * @typedef {object} DashSummaryEntry
 * @property {string} dependency
 * @property {string} license
 * @property {string} status
 * @property {string} source
 */
