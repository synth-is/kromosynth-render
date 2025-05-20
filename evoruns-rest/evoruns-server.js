// REST server providing data vrom evolution runs

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const nthline = require('nthline');
const { execSync, spawn } = require('child_process');

const app = express();
app.use(cors({ 
  origin: true 
  // origin: ['https://localhost....', '...']
}));
const PORT = process.env.PORT || 3003;

// Initialize Firebase Admin SDK
const serviceAccount = require('./synth-is-firebase-adminsdk-7ycvy-421ca1f367.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // databaseURL: 'https://your-firebase-project-id.firebaseio.com',
});

// Initialize Firestore
const db = admin.firestore();

// Middleware to parse incoming requests with JSON payloads
app.use(bodyParser.json());

// Middleware to verify Firebase ID token for anonymous login
const verifyFirebaseToken = async (req, res, next) => {
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const idToken = req.headers.authorization.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
};

const BASE_PATH = '/Users/bthj';
const parentDirectoryPaths = [
  '/QD-Fox/evoruns/conf-duration_delta_pitch_combinations-singleCellWin',
  '/QD-Fox/evoruns/conf-single-class-runs',
  '/QD-Fox/evoruns/conf-single-class-runs_112-dur-pitch-vel-comb',
  '/QD-Fox/evoruns/conf-static_mutation_rate_combinations_-_delete_rates-singleCellWin',
  '/QD-Fox/evoruns/conf-static_mutation_rate_combinations-singleCellWin',

  '/QD-ROBIN/evoruns/conf-duration_delta_pitch_combinations',
  '/QD-ROBIN/evoruns/conf-duration_delta_pitch_combinations-deepGrid',
  '/QD-ROBIN/evoruns/conf-static_mutation_rate_combinations',
  '/QD-ROBIN/evoruns/conf-static_mutation_rate_combinations_-_delete_rates',
  '/QD-ROBIN/evoruns/conf-static_mutation_rate_combinations_-_delete_rates-deepGrid',
  '/QD-ROBIN/evoruns/conf-static_mutation_rate_combinations-deepGrid',

  '/QD-SAGA/QD/evoruns/conf-duration_delta_pitch_combinations-deepGrid',
  '/QD-SAGA/QD/evoruns/conf-single-class-runs',

  // '/QD-FOX/evoruns/conf-duration_delta_pitch_combinations-singleCellWin',
  // '/QD-FOX/evoruns/conf-single-class-runs',
  // '/QD-FOX/evoruns/conf-single-class-runs_112-dur-pitch-vel-comb',
  // '/QD-FOX/evoruns/conf-static_mutation_rate_combinations_-_delete_rates-singleCellWin',
  // '/QD-FOX/evoruns/conf-static_mutation_rate_combinations-singleCellWin',
];

// From a list of parent directory paths, read all subdirectory paths from disk and return them as a list
async function getSubdirectoryPathsFromParentDirectoryPaths() {
  const subdirectoryPaths = [];
  for( const parentDirectoryPath of parentDirectoryPaths ) {
    const subdirectoryNames = await fs.readdir(BASE_PATH+parentDirectoryPath);
    subdirectoryNames.forEach( (subdirectoryName) => {
      const subdirectoryPath = path.join(parentDirectoryPath, subdirectoryName);
      // if subdirectoryPathe does not end with "failed-genes", add it to the list of subdirectory paths
      if ( ! subdirectoryPath.endsWith('failed-genes') && ! subdirectoryPath.endsWith('.DS_Store') ) {
        subdirectoryPaths.push(subdirectoryPath);
      } 
    });
  }
  return subdirectoryPaths;
}

// the following methods, until Routes, are based on qd-run-analysis.js in kromosynth-cli

async function getClasses( evoRunDirPath ) {
  const lastCommitIndex = getCommitCount( evoRunDirPath ) - 1;
  console.log('lastCommitIndex:', lastCommitIndex);
  const eliteMap = await getEliteMap( evoRunDirPath, lastCommitIndex );
  const classes = Object.keys(eliteMap.cells).filter( (className) => eliteMap.cells[className].elts.length > 0 ).sort();
  return classes;
}

async function getEliteMap( evoRunDirPath, iterationIndex, forceCreateCommitIdsList ) {
  const commitId = await getCommitID( evoRunDirPath, iterationIndex, forceCreateCommitIdsList );
  const evoRunId = evoRunDirPath.split('/').pop();
  const eliteMapString = await spawnCmd(`git -C ${evoRunDirPath} show ${commitId}:elites_${evoRunId}.json`, {}, true);
  const eliteMap = JSON.parse(eliteMapString);
  return eliteMap;
}

async function getCommitID( evoRunDirPath, iterationIndex, forceCreateCommitIdsList ) {
  const commitIdsFilePath = getCommitIdsFilePath( evoRunDirPath, forceCreateCommitIdsList );
  let commitId;
  if( iterationIndex === undefined ) {
    // get last index
    const commitCount = getCommitCount( evoRunDirPath, forceCreateCommitIdsList );
    console.log('commitCount:', commitCount);
    const lastCommitIndex = commitCount - 1;
    commitId = await nthline(lastCommitIndex, commitIdsFilePath);
  } else {
    commitId = await nthline(iterationIndex, commitIdsFilePath);
  }
  return commitId;
}

function getCommitCount( evoRunDirPath, forceCreateCommitIdsList ) {
  const commitIdsFilePath = getCommitIdsFilePath( evoRunDirPath, forceCreateCommitIdsList );
  const commitCount = parseInt(runCmd(`wc -l < ${commitIdsFilePath}`));
  return commitCount;
}

function getCommitIdsFilePath( evoRunDirPath, forceCreateCommitIdsList ) {
  const commitIdsFileName = "commit-ids.txt";
  const commitIdsFilePath = `${evoRunDirPath}/${commitIdsFileName}`;
  if( forceCreateCommitIdsList || ! fsSync.existsSync(`${evoRunDirPath}/commit-ids.txt`) ) {
    runCmd(`git -C ${evoRunDirPath} rev-list HEAD --first-parent --reverse > ${commitIdsFilePath}`);
  }
  return commitIdsFilePath;
}


// END - the following methods, until Routes, are based on qd-run-analysis.js in kromosynth-cli


///// Routes

// Route to get all evolution run paths
app.get('/evorunpaths', async (req, res) => {
  try {
    const evolutionRuns = await getSubdirectoryPathsFromParentDirectoryPaths();
    res.json(evolutionRuns);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get evolution runs - ' + error});
  }
});

// Route to get all classes for one evolution run path, where the run path is suppled as a query parameter
app.get('/classes', async (req, res) => {
  const evoRunDirPath = req.query.evoRunDirPath;
  if( ! evoRunDirPath ) {
    return res.status(400).json({ error: 'Missing query parameter evoRunDirPath' });
  }
  try {
    const classes = await getClasses( BASE_PATH+evoRunDirPath );
    res.json(classes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get classes - ' + error});
  }
});

// Route to get the iteration count for one evolution run path, where the run path is suppled as a query parameter
app.get('/iteration-count', async (req, res) => {
  const evoRunDirPath = req.query.evoRunDirPath;
  if( ! evoRunDirPath ) {
    return res.status(400).json({ error: 'Missing query parameter evoRunDirPath' });
  }
  try {
    const commitCount = getCommitCount( BASE_PATH+evoRunDirPath );
    res.json(commitCount);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get iteration count - ' + error});
  }
});

// Route to get genome string for one class, and one iteration, in one evolution run path, where the run path, class and iteration are suppled as query parameters
app.get('/genome-string', async (req, res) => {
  const evoRunDirPath = req.query.evoRunDirPath;
  const className = req.query.class;
  const iterationIndex = parseInt( req.query.generation );
  if( ! evoRunDirPath ) {
    return res.status(400).json({ error: 'Missing query parameter evoRunDirPath' });
  }
  if( ! className ) {
    return res.status(400).json({ error: 'Missing query parameter class' });
  }
  if( ! iterationIndex ) {
    // TODO: get last iteration index, if not supplied
    return res.status(400).json({ error: 'Missing query parameter generation' });
  }
  try {
    const eliteMap = await getEliteMap( BASE_PATH+evoRunDirPath, iterationIndex );
    const genomeId = eliteMap.cells[className].elts[0].g;
    const genomeString = await readGenomeAndMetaFromDisk( evoRunDirPath.split('/').pop(), genomeId, BASE_PATH+evoRunDirPath );
    res.send(genomeString);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get genome string - ' + error});
  }
});

// Route to get genome metadata for one class, and one iteration, in one evolution run path, where the run path, class and iteration are suppled as query parameters
app.get('/genome-metadata', async (req, res) => {
  const evoRunDirPath = req.query.evoRunDirPath;
  const className = req.query.class;
  const iterationIndex = parseInt( req.query.generation );
  if( ! evoRunDirPath ) {
    return res.status(400).json({ error: 'Missing query parameter evoRunDirPath' });
  }
  if( ! className ) {
    return res.status(400).json({ error: 'Missing query parameter class' });
  }
  if( ! iterationIndex ) {
    // TODO: get last iteration index, if not supplied
    return res.status(400).json({ error: 'Missing query parameter generation' });
  }
  try {
    const eliteMap = await getEliteMap( BASE_PATH+evoRunDirPath, iterationIndex );
    const genomeId = eliteMap.cells[className].elts[0].g;
    const score = eliteMap.cells[className].elts[0].s;
    const genomeString = await readGenomeAndMetaFromDisk( evoRunDirPath.split('/').pop(), genomeId, BASE_PATH+evoRunDirPath );
    const genomeAndMeta = JSON.parse(genomeString);
    
    let tags, duration, noteDelta, velocity, updated;
    if( genomeAndMeta.genome.tags ) {
      const tagForCell = genomeAndMeta.genome.tags.find(t => t.tag === className);
      ({ duration, noteDelta, velocity, updated } = tagForCell);
      tags = genomeAndMeta.genome.tags.map( t => t.tag );
    } else {
      duration = 1;
      noteDelta = 0;
      velocity = 1;
    }
    let parentGenomeClass;
    if( genomeAndMeta.genome.parentGenomes && genomeAndMeta.genome.parentGenomes.length > 0 ) {
      parentGenomeClass = genomeAndMeta.genome.parentGenomes[0].eliteClass;
    }
    res.json({ genomeId, score, duration, noteDelta, velocity, updated, parentGenomeClass, tags });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get genome string - ' + error});
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


///// functions adapted from qd-common.js in kromosynth-cli

function runCmd( cmd ) {
  try {
    return execSync(cmd).toString();
  } catch (e) {
    throw e;
  }
}

// https://stackoverflow.com/a/68958420/169858 (not restricted by the shell buffer limitation (as `runCmd*` are))
function spawnCmd(instruction, spawnOpts = {}, silenceOutput = false) {
  return new Promise((resolve, reject) => {
      let errorData = "";

      const [command, ...args] = instruction.split(/\s+/);

      if (process.env.DEBUG_COMMANDS === "true") {
          console.log(`Executing \`${instruction}\``);
          console.log("Command", command, "Args", args);
      }

      const spawnedProcess = spawn(command, args, spawnOpts);

      let data = "";

      spawnedProcess.on("message", console.log);

      spawnedProcess.stdout.on("data", chunk => {
          if (!silenceOutput) {
              console.log(chunk.toString());
          }

          data += chunk.toString();
      });

      spawnedProcess.stderr.on("data", chunk => {
          errorData += chunk.toString();
      });

      spawnedProcess.on("close", function(code) {
          if (code > 0) {
              return reject(new Error(`${errorData} (Failed Instruction: ${instruction})`));
          }

          resolve(data);
      });

      spawnedProcess.on("error", function(err) {
          reject(err);
      });
  });
}

async function readGenomeAndMetaFromDisk( evolutionRunId, genomeId, evoRunDirPath ) {
  let genomeJSONString;
  try {
    const genomeKey = getGenomeKey(evolutionRunId, genomeId);
    const genomeFilePath = `${evoRunDirPath}/${genomeKey}.json`;
    if( fsSync.existsSync(genomeFilePath) ) {
      genomeJSONString = fsSync.readFileSync(genomeFilePath, 'utf8');
    }
  } catch( err ) {
    console.error("readGenomeFromDisk: ", err);
  }
  return genomeJSONString;
}

function getGenomeKey( evolutionRunId, genomeId ) {
  return `genome_${evolutionRunId}_${genomeId}`;
}