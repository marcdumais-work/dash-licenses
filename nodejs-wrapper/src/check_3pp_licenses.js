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
/** JSON.Stringify() replacer that handles regexps */
const regExpReplacer = (key, value) => {
    if (value instanceof RegExp) {
      return value.toString();
    }
    return value;
};
const dashLicensesJar = path.resolve(__dirname, 'download/dash-licenses.jar');
const dashLicensesDownloadUrl = 'https://repo.eclipse.org/service/local/artifact/maven/redirect?r=dash-licenses&g=org.eclipse.dash&a=org.eclipse.dash.licenses&v=LATEST';
const dashLicensesInternalError = 127;

// CLI parameters meant to be passed when calling dash-licenses
const dashParams = [
    "batch",
    "project",
    "review",
    "summary",
    "timeout",
];

// CLI parameters accepted/processed by this script, and corresponding 
// Regexps to parse them and their values
const wrapperCLIRegexps = {
    "configFile": /--(configFile)=(\S+).*/,
    "batch": /--(batch)=(\d+).*/,
    "dryRun": /--(dryRun)/,
    "exclusions": /--(exclusions)=(\S+).*/,
    "inputFile": /--(inputFile)=(\S+).*/,
    "project": /--(project)=(\S+).*/,
    "review": /--(review)/,
    "summary": /--(summary)=(\S+).*/,
    "timeout": /--(timeout)=(\d+).*/
};

/** Effective configuration, after resolving defaults, config file and CLI */
const dashLicensesConfig = {};

/**
 * Default values for configurable parameters
 * Note: We do not handle the Gitlab token. Instead, an environment variable 
 * should be used 
 */
const dashLicensesConfigDefaults = {
    // Batch size. Passed as-it to dash-licenses
    "batch": 50,
    // default config file, to fine-tune dash-licenses options
    "configFile": "dashLicensesConfig.json",
    // Run in dry run mode - do not create IP tickets
    "dryRun": false,
    // File where exclusions are defined. Any excluded dependency will not cause
    // this wrapper to exit with an error status (on its own) or be reported in
    // the post-run status as requiring more scrutiny
    "exclusions": "dependency-check-exclusions.json",
    // File where dependencies are defined. Passed as-it to dash-licenses
    "inputFile": "yarn.lock",
    // Eclipse Foundation project name. e.g. "ecd.theia", "ecd.cdt-cloud"
    "project": "",
    // Use dash-license "review" mode, to automatically create IP tickets for any suspicious dependencies? 
    "review": false,
    // Summary file, in which dash-licenses will save its findings
    "summary": "dependency-check-summary.txt",
    // Timeout. Passed as-it to dash-licenses
    "timeout": 240
};

resolveConfig();

// review mode has further requirements (PAT) that may force us to turn it off, even if
// requested
let autoReviewMode = dashLicensesConfig.review;
const projectName = dashLicensesConfig.project;
const depsInputFile = dashLicensesConfig["inputFile"];
const batch = dashLicensesConfig.batch;
const timeout = dashLicensesConfig.timeout;
const summaryFile = path.resolve(dashLicensesConfig["summary"]);
const exclusionsFile = dashLicensesConfig["exclusions"];
const dryRun = dashLicensesConfig["dryRun"];


// A Eclipse Foundation Gitlab Personal Access Token, generated by an Eclipse committer,
// is required to use dash-licenses in "review" mode. For more information see:
// https://github.com/eclipse/dash-licenses#automatic-ip-team-review-requests 
//
// Reminder: Do NOT share or expose your token!
//
// e.g. Set the token locally like so (bash shell):
// $> export DASH_TOKEN=<your_token>
//
// Since dash-licenses can consume the PAT directly from the environment, let's just
// confirm whether it's set or not
const isPersonalAccessTokenSet = "DASH_TOKEN" in process.env;

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
    if (autoReviewMode && !isPersonalAccessTokenSet) {
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
    if (fs.existsSync(summaryFile)) {
        info('Backing up previous summary...');
        fs.renameSync(summaryFile, `${summaryFile}.old`);
    }
    info('Running dash-licenses...');
    const args = ['-jar', dashLicensesJar, depsInputFile, '-batch', '50', '-timeout', '240', '-summary', summaryFile];
    // use project name if defined - it makes results more precise. e.g. it lets 
    // dash-licenses take into account project-specific "works with" approvals
    if (projectName) {
        args.push('-project', projectName);
        if (autoReviewMode && isPersonalAccessTokenSet) {
            info(`Using "review" mode for project: ${projectName}`);
            args.push('-review');
        }
    }
    if (dryRun) {
        info('Dry-run mode enabled - exiting before launching dash-licenses');
        process.exit(0);
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

    const restricted = await getRestrictedDependenciesFromSummary(summaryFile);
    // filter-out restricted dependencies that are in the exclusion file
    if (restricted.length > 0) {
        if (fs.existsSync(exclusionsFile)) {
            info('Checking results against the exclusions...');
            const exclusions = readExclusions(exclusionsFile);
            const unmatched = new Set(exclusions.keys());
            const unhandled = restricted.filter(entry => {
                unmatched.delete(entry.dependency);
                return !exclusions.has(entry.dependency);
            });
            if (unmatched.size > 0) {
                warn('Some entries in the exclusions did not match anything from dash-licenses output:');
                warn("(perhaps these entries are no longer required?)");
                for (const dependency of unmatched) {
                    console.log(magenta(`> ${dependency}`));
                    const data = exclusions.get(dependency);
                    if (data) {
                        console.warn(`${dependency}:`, data);
                    }
                }
            }
            if (unhandled.length > 0) {
                error(`Found results that aren't part of the exclusions!`);
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

function getPrintableConfig(configObj) {
    return JSON.stringify(configObj, regExpReplacer, 2);
}

/**
 * Figure-out the effective value to use for each parameter, taking into 
 * account the defaults, and, as needed, what was provided in a config file 
 * and/or the CLI.
 */
function resolveConfig() {
    let configFile = dashLicensesConfigDefaults.configFile;
    // Parse optional configuration provided from the CLI, skipping 
    // the first 2 entries that are not the arguments we are looking for
    const dashLicensesConfigFromCLI = parseCLI(process.argv.slice(2));

    // before resolving the config, check if a config file was provided 
    // on CLI that overrides defaults
    if ("configFile" in dashLicensesConfigFromCLI) {
        configFile = path.resolve(String(dashLicensesConfigFromCLI.configFile));
    } 

    // optional configuration provided from a config file
    const dashLicensesConfigFromFile = parseConfigFile(configFile);

    // Resolve configuration: In order of priority (highest to lowest): 
    // CLI, config file, defaults
    Object.keys(dashLicensesConfigDefaults).map(k => {
        const defaultValue = dashLicensesConfigDefaults[k];
        const configFileValue = dashLicensesConfigFromFile[k];
        const CLIValue = dashLicensesConfigFromCLI[k];

        dashLicensesConfig[k] = (CLIValue || configFileValue || defaultValue);
    });


    info("Effective configuration: ");
    info("-------------------------------------");
    info(getPrintableConfig(dashLicensesConfig));
    info("-------------------------------------\n");
}

/**
 * If it exists, read config file and parse the parameters/values defined therein
 * @param {string} file 
 * @returns {Object} config file parameters/values
 */
function parseConfigFile(file) {
    const configFromFile = {};
    const dashLicensesConfigFile = path.resolve(file);
    if (fs.existsSync(dashLicensesConfigFile)) {
        const wsConfig = JSON.parse(fs.readFileSync(dashLicensesConfigFile, 'utf8'));
        // prefer config file entries vs defaults
        Object.keys(wsConfig).map(k => {
            const value = wsConfig[k];
            // only consider known parameters
            if (k in dashLicensesConfigDefaults) {
                // exclude undefined values and also empty or white-space strings
                if (value !== undefined && (typeof value != 'string' || value.trim() != "")) {
                    configFromFile[k] = wsConfig[k];    
                } else {
                    warn(`(${path.basename(dashLicensesConfigFile)}) - config file entry "${k}" is undefined - ignoring it`); 
                }
            } else {
                warn(`Unknown config file entry: \"${k}\" - ignoring it"`);
            }
        });
        info("Parsed config file arguments: ");
        info(`(From file: ${dashLicensesConfigFile})`);
        info("-------------------------------------");
        info(getPrintableConfig(configFromFile));
        info("-------------------------------------\n");
    } else {
        warn(`Config file not found: ${dashLicensesConfigFile} - ignoring it"`);
    }
    return configFromFile;
}

/**
 * Parse CLI arguments that are recognized as valid configuration parameters
 * @param {*} CLIArgs 
 * @returns {Object} CLI config parameters/values
 */
function parseCLI(CLIArgs) {
    const configFromCLI = {};
    let argParseIssue = false;
    // Go through all CLI arguments
    CLIArgs.forEach(CLIArg => {
        // look for regexp match to parse this arg
        const found = Object.values(wrapperCLIRegexps).find( rx => {
            const RegexpResult = rx.exec(CLIArg);
            if(RegexpResult) {
                // parse arg - some have no "value" part
                const [arg, val] = CLIArg.replace(rx, (_, group1, group2) => group2 ? `${group1} ${group2}` : group1).split(' ');
                configFromCLI[arg] = val || true;
                // found the right regexp - find() should stop looking
                return RegexpResult;
            }
        }) ? true : false;
        if (!found) {
            argParseIssue = true;
            warn(`The following CLI argument was not parsed successfully: "${CLIArg}"`);
        }
    });

    if (argParseIssue) {
        warn(`Here are the supported CLI configurations and the Regular Expressions used to parse them:`);
        warn(getPrintableConfig(wrapperCLIRegexps));
    }

    info("Parsed CLI arguments: ");
    info("-------------------------------------");
    info(getPrintableConfig(configFromCLI));
    info("-------------------------------------\n");
    return configFromCLI;
}

/**
 * Use arguments passed on the CLI, in preference to default or config file values
 */
// function applyConfigCLI() {
//     Object.keys(dashLicensesConfigFromCLI).map(k => {
//         const value = dashLicensesConfigFromCLI[k];
//         // only consider known parameters
//         if (k in dashLicensesConfig) {
//             configFromCLI[k] = value;
//         }
//     });
// }

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
 * Handle both list and object format for the exclusions json file.
 * @param {string} exclusions path to the exclusions json file.
 * @returns {Map<string, any>} map of dependencies to ignore if restricted, value is an optional data field.
 */
function readExclusions(exclusions) {
    const json = JSON.parse(fs.readFileSync(exclusions, 'utf8'));
    if (Array.isArray(json)) {
        return new Map(json.map(element => [element, null]));
    } else if (typeof json === 'object' && json !== null) {
        return new Map(Object.entries(json));
    }
    console.error(`ERROR: Invalid format for "${exclusions}"`);
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
