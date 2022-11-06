import * as path from 'path';
import * as mkdirp from 'mkdirp';
import * as sfs from 'fs';

import { cloneOrFetchRepo, cloneRepo, checkoutSha, getWorkdirForRepoUrl,
  getTempdirForRepoUrl, getOriginForRepo, getHeadForRepo, resetOriginUrl } from './git-api';
import { getSanitizedRepoUrl, getNwoFromRepoUrl, postCommitStatus, createGist,
  findPRForCommit } from './github-api';
import { determineBuildCommands, runAllBuildCommands, uploadBuildArtifacts } from './build-api';
import * as fs from 'mz/fs';
import { rimraf } from './recursive-fs';
import { retryPromise } from './promise-array';

import {Observable} from 'rxjs';
import * as ON_DEATH from 'death';

const DeathPromise = new Promise<number>((_res,rej) => {
  ON_DEATH((sig: number) => rej(new Error(`Signal ${sig} thrown`)));
});

// tslint:disable-next-line:no-var-requires
const d = require('debug')('surf:surf-build');

function getRootAppDir() {
  let ret = null;
  let tmp = process.env.TMPDIR || process.env.TEMP || '/tmp';

  switch (process.platform) {
  case 'win32':
    ret = path.join(process.env.LOCALAPPDATA!, 'surf');
    break;
  case 'darwin':
    ret = process.env.HOME ?
      path.join(process.env.HOME!, 'Library', 'Application Support', 'surf') :
      path.join(tmp, 'surf-repos');
    break;
  default:
    ret = process.env.HOME ?
      path.join(process.env.HOME!, '.config', 'surf') :
      path.join(tmp, 'surf-repos');
    break;
  }

  mkdirp.sync(ret);
  return ret;
}

function getRepoCloneDir() {
  return path.join(getRootAppDir(), 'repos');
}

function truncateErrorMessage(errorMessage: string) {
  return (errorMessage.split('\n')[0]).substr(0, 256);
}

export default function main(argv: any, showHelp: (() => void)) {
  let doIt = Observable.merge(
    Observable.fromPromise(realMain(argv, showHelp)),
    Observable.fromPromise(DeathPromise)
  ).take(1).toPromise();

  return doIt
    .then((x) => Promise.resolve(x), (e) => {
      d('Build being taken down!');
      if (argv.name) {
        let repo = argv.repo || process.env.SURF_REPO;
        let sha = argv.sha || process.env.SURF_SHA1;
        let nwo = getNwoFromRepoUrl(repo);

        console.error(`Build Errored: ${e.message}`);

        d(`Attempting to post error status!`);
        return retryPromise(() => {
          return postCommitStatus(nwo, sha, 'error', `Build Errored: ${truncateErrorMessage(e.message)}`, null, argv.name);
        })
          .catch(() => true)
          .then(() => d(`We did it!`))
          .then(() => Promise.reject(e));
      } else {
        return Promise.reject(e);
      }
    });
}

async function configureEnvironmentVariablesForChild(nwo: string, sha: string, name: string, repo: string) {
  process.env.SURF_NWO = nwo;
  process.env.SURF_REPO = repo;
  if (name) process.env.SURF_BUILD_NAME = name;

  // If the current PR number isn't set, try to recreate it
  try {
    if (!process.env.SURF_PR_NUM) {
      let pr = await findPRForCommit(nwo, sha);

      if (pr) {
        process.env.SURF_PR_NUM = pr.number;
        process.env.SURF_REF = pr.head.ref;
      }
    }
  } catch (e) {
    d(`Couldn't fetch PR for commit: ${e.message}`);
  }
}

async function realMain(argv: any, showHelp: (() => void)) {
  let sha = argv.sha || process.env.SURF_SHA1;
  let repo = argv.repo || process.env.SURF_REPO;
  let name = argv.name;
  let logsonly = argv.logsonly;

  if (argv.help) {
    showHelp();
    process.exit(0);
  }

  if (name === '__test__') {
    // NB: Don't end up setting statuses in unit tests, even if argv.name is set
    name = null;
  }

  if (!repo) {
    try {
      repo = getSanitizedRepoUrl(await getOriginForRepo('.'));
      argv.repo = repo;
    } catch (e) {
      console.error('Repository not specified and current directory is not a Git repo');
      d(e.stack);

      showHelp();
      process.exit(-1);
    }
  }

  if (!repo) {
    showHelp();
    process.exit(-1);
  }

  let repoDir = getRepoCloneDir();

  d(`Running initial cloneOrFetchRepo: ${repo} => ${repoDir}`);
  let bareRepoDir = await retryPromise(() => cloneOrFetchRepo(repo, repoDir));

  if (!sha) {
    d(`SHA1 not specified, trying to retrieve SHA1 for current repo in directory`);
    try {
      sha = await getHeadForRepo(process.cwd());
      argv.sha = sha;
      d(`Current checkout is at ${sha}`);
    } catch (e) {
      console.error(`Failed to find the commit for cwd ${process.cwd()}: ${e.message}`);
      d(e.stack);
    }
  }

  if (!sha) {
    d(`SHA1 not specified, trying to retrieve default branch`);
    try {
      sha = await getHeadForRepo(bareRepoDir);
      argv.sha = sha;
      d(`Default branch is ${sha}`);
    } catch (e) {
      console.error(`Failed to find the current commit for repo ${repo}: ${e.message}`);
      d(e.stack);

      showHelp();
      process.exit(-1);
    }
  }

  let nwo = getNwoFromRepoUrl(repo);
  await configureEnvironmentVariablesForChild(nwo, sha, name, repo);

  d(`repo: ${repo}, sha: ${sha}`);

  if (name) {
    d(`Posting 'pending' to GitHub status`);

    let nwo = getNwoFromRepoUrl(repo);
    await retryPromise(() =>
      postCommitStatus(nwo, sha, 'pending', 'Surf Build Server', null, name));
  }

  let workDir = getWorkdirForRepoUrl(repo, sha);
  let tempDir = getTempdirForRepoUrl(repo, sha);

  d(`Cloning to work directory: ${workDir}`);
  await retryPromise(() => cloneRepo(bareRepoDir, workDir, '', false));

  d(`Checking out to given SHA1: ${sha}`);
  await checkoutSha(workDir, sha);

  d(`Resetting remote origin to URL`);
  await resetOriginUrl(workDir, repo);

  d(`Determining command to build`);
  let { cmds, artifactDirs } = await determineBuildCommands(workDir, sha);

  if (logsonly) {
    d(`Ignoring build artifacts, only uploading build log`);
    artifactDirs = [];
  }

  let buildPassed = true;
  let buildLog = path.join(workDir, 'build-output.log');
  let fd = await fs.open(buildLog, 'w');

  try {
    let buildStream = runAllBuildCommands(cmds, workDir, sha, tempDir);

    buildStream.concatMap((x) => {
      console.log(x.replace(/[\r\n]+$/, ''));
      return Observable.fromPromise(fs.write(fd, x, undefined, 'utf8'));
    }).subscribe(() => {}, (e) => {
      console.error(e.message);
      sfs.writeSync(fd, `${e.message}\n`, null, 'utf8');
    });

    await buildStream
      .reduce(() => null)
      .toPromise();
  } catch (_e) {
    // NB: We log this in the subscribe statement above
    buildPassed = false;
  } finally {
    sfs.closeSync(fd);
  }

  if (name) {
    d(`Posting to GitHub status`);
    let nwo = getNwoFromRepoUrl(repo);

    let gistInfo = await retryPromise(() => createGist(`Build completed: ${nwo}#${sha}, ${new Date()}`, {
      'README.md': { content: `## Build for ${nwo} ${buildPassed ? 'succeeded' : 'failed'} on ${new Date()}` }
    }));

    d(`Gist result: ${gistInfo.result.html_url}`);
    d(`Gist clone URL: ${gistInfo.result.git_pull_url}`);
    let token = process.env.GIST_TOKEN || process.env.GITHUB_TOKEN || '';

    try {
      d(`Uploading build artifacts using token: ${token}`);
      await retryPromise(() =>
        uploadBuildArtifacts(gistInfo.result.id, gistInfo.result.git_pull_url, artifactDirs || [], buildLog, token));
    } catch (e) {
      console.error(`Failed to upload build artifacts: ${e.message}`);
      d(e.stack);
    }

    await postCommitStatus(nwo, sha,
      buildPassed ? 'success' : 'failure', 'Surf Build Server', gistInfo.result.html_url, name);
  }

  if (buildPassed && !process.env.DEBUG) {
    await rimraf(tempDir);
  }

  return buildPassed ? 0 : -1;
}
