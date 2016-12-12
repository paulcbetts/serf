import path from 'path';
import mkdirp from 'mkdirp';
import { cloneOrFetchRepo, cloneRepo, checkoutSha, getOriginForRepo, 
  getHeadForRepo, resetOriginUrl } from './git-api';
import { getWorkdirForRepoUrl, getTempdirForRepoUrl } from './workdir-api';
import { getSanitizedRepoUrl, getNwoFromRepoUrl, postCommitStatus, createGist,
  findPRForCommit } from './github-api';
import { determineBuildCommands, runAllBuildCommands, uploadBuildArtifacts } from './build-api';
import { fs, rimraf } from './promisify';
import { retryPromise } from './promise-array';

import {Observable} from 'rxjs';
import ON_DEATH from 'death';

const DeathPromise = new Promise((res,rej) => {
  ON_DEATH((sig) => rej(new Error(`Signal ${sig} thrown`)));
});

const d = require('debug')('surf:surf-build');

function getRootAppDir() {
  let ret = null;
  let tmp = process.env.TMPDIR || process.env.TEMP || '/tmp';

  switch (process.platform) {
  case 'win32':
    ret = path.join(process.env.LOCALAPPDATA, 'surf');
    break;
  case 'darwin':
    ret = process.env.HOME ?
      path.join(process.env.HOME, 'Library', 'Application Support', 'surf') :
      path.join(tmp, 'surf-repos');
    break;
  default:
    ret = process.env.HOME ?
      path.join(process.env.HOME, '.config', 'surf') :
      path.join(tmp, 'surf-repos');
    break;
  }

  mkdirp.sync(ret);
  return ret;
}

function getRepoCloneDir() {
  return path.join(getRootAppDir(), 'repos');
}

function truncateErrorMessage(errorMessage) {
  return (errorMessage.split('\n')[0]).substr(0, 256);
}

export default function main(argv, showHelp) {
  let doIt = Observable.merge(
    Observable.fromPromise(realMain(argv, showHelp)),
    Observable.fromPromise(DeathPromise)
  ).take(1).toPromise();

  return doIt
    .then(() => Promise.resolve(true), (e) => {
      d("Build being taken down!");
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

async function configureEnvironmentVariablesForChild(nwo, sha, name, repo) {
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

async function realMain(argv, showHelp) {
  let sha = argv.sha || process.env.SURF_SHA1;
  let repo = argv.repo || process.env.SURF_REPO;
  let name = argv.name;

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
      console.error("Repository not specified and current directory is not a Git repo");
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
  await retryPromise(() => cloneRepo(bareRepoDir, workDir, null, false));

  d(`Checking out to given SHA1: ${sha}`);
  await checkoutSha(workDir, sha);

  d(`Resetting remote origin to URL`);
  await resetOriginUrl(workDir, repo);

  d(`Determining command to build`);
  let { cmd, cmds, args, artifactDirs } = await determineBuildCommands(workDir);

  if (!cmds) {
    cmds = [{cmd, args}];
  }

  let buildPassed = false;
  let buildOutput = null;

  try {
    let buildStream = runAllBuildCommands(cmds, workDir, sha, tempDir);

    buildOutput = '';
    buildStream.subscribe((x) => {
      buildOutput += x;
      console.log(x.replace(/[\r\n]+$/, ''));
    }, () => {});

    await buildStream
      .reduce(() => null)
      .toPromise();

    buildPassed = true;
  } catch (e) {
    buildOutput += `\n${e.message}`;
    d(e.stack);
  }

  await fs.writeFile(path.join(workDir, 'build-output.log'), buildOutput);

  if (name) {
    d(`Posting 'success' to GitHub status`);
    let nwo = getNwoFromRepoUrl(repo);

    let gistInfo = await retryPromise(() => createGist(`Build completed: ${nwo}#${sha}, ${new Date()}`, {
      "build-output.txt": {
        content: buildOutput
      }
    }));

    d(`Gist result: ${gistInfo.result.html_url}`);
    d(`Gist clone URL: ${gistInfo.result.git_pull_url}`);
    if (buildPassed) {
      let token = process.env.GIST_TOKEN || process.env.GITHUB_TOKEN;

      try {
        d(`Uploading build artifacts using token: ${token}`);
        let targetDir = await retryPromise(() => uploadBuildArtifacts(gistInfo.result.id, gistInfo.result.git_pull_url, artifactDirs, token));
        await rimraf(targetDir);
      } catch (e) {
        console.error(`Failed to upload build artifacts: ${e.message}`);
        d(e.stack);
      }
    }

    await postCommitStatus(nwo, sha,
      buildPassed ? 'success' : 'failure', 'Surf Build Server', gistInfo.result.html_url, name);
  }

  if (buildPassed && !process.env.DEBUG) {
    await rimraf(tempDir);
  }

  if (!buildPassed) {
    throw new Error(buildOutput);
  }
}
