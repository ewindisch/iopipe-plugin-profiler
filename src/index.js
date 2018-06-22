import * as inspector from 'inspector';
import * as urlLib from 'url';
import get from 'lodash.get';
import request from './request';
import enabled from './enabled';
import getSignerHostname from './signer';
import * as archiver from 'archiver';
import * as stream from 'stream';

const pkg = require('../package.json');

//var v8 = require("v8"); v8.setFlagsFromString("--trace");

const defaultConfig = {
  recSamples: true,
  sampleRate: 1000,
  enabled: false,
  heapSnapshot: false,
  debug: false
};

class ProfilerPlugin {
  constructor(pluginConfig = defaultConfig, invocationInstance) {
    this.invocationInstance = invocationInstance;
    this.token = get(this.invocationInstance, 'config.clientId');
    this.config = Object.assign({}, defaultConfig, pluginConfig);
    this.profilerEnabled = enabled(
      'IOPIPE_ENABLE_PROFILER',
      this.config.enabled
    );
    this.heapsnapshotEnabled = enabled(
      'IOPIPE_ENABLE_HEAPSNAPSHOT',
      this.config.heapSnapshot
    );
    this.enabled = this.profilerEnabled || this.heapsnapshotEnabled;
    this.uploads = [];

    this.hooks = {
      'pre:invoke': this.preInvoke.bind(this),
      'post:invoke': this.postInvoke.bind(this),
      'post:report': this.postReport.bind(this)
    };
    this.inspector = new inspector.Session();

    // Enable the remote inspector (on localhost)
    //process.kill(process.pid, 'SIGUSR1');
    return this;
  }

  log(logline) {
    this.config.debug ? console.log(`@iopipe/profiler::${logline}`) : null;
  }

  get meta() {
    return {
      name: pkg.name,
      version: pkg.version,
      homepage: pkg.homepage,
      enabled: this.enabled,
      uploads: this.uploads
    };
  }

  preInvoke() {
    if (!this.enabled) {
      return;
    }

    try {
      this.inspector.disconnect();
    } catch (err) {
      this.log(`warning disconnecting to inspector: ${err}`);
    }

    try {
      this.inspector.connect();
    } catch (err) {
      this.log(`warning connecting to inspector: ${err}`);
    }

    if (this.heapsnapshotEnabled) {
      this.inspector.post('HeapProfiler.enable', err => {
        if (err) {
          this.log(`Error enabling profiler::${err}`);
        }
      });
    }
    if (this.profilerEnabled) {
      this.inspector.post('Profiler.enable', errEnable => {
        if (errEnable) {
          this.log(`Error enabling profiler::${errEnable}`);
        }
        this.inspector.post(
          'Profiler.setSamplingInterval',
          { interval: this.config.sampleRate },
          err => {
            if (err) {
              this.log(`Error from profiler::${err}`);
            }
            this.inspector.post('Profiler.start', errStart => {
              if (errStart) {
                this.log(`Error starting profiler::${errStart}`);
              }
            });
          }
        );
      });
    }
  }

  async getSignedUrl(obj = this.invocationInstance) {
    const { startTimestamp, context = {} } = obj;
    const hostname = getSignerHostname();
    this.log(`Requesting signed url from ${hostname}`);
    const signingRes = await request(
      JSON.stringify({
        arn: context.invokedFunctionArn,
        requestId: context.awsRequestId,
        timestamp: startTimestamp,
        extension: '.zip'
      }),
      'POST',
      {
        hostname,
        path: '/'
      },
      this.token
    );

    // Parse response to get signed url
    const response = JSON.parse(signingRes);
    // attach uploads to plugin data
    this.uploads.push(response.jwtAccess);
    return response.signedRequest;
  }

  async postInvoke() {
    if (!this.enabled) return false;

    return new Promise(async resolve => {
      var filesSeen = 0;
      try {
        const signedRequestURL = await this.getSignedUrl();
        const archive = archiver.default('zip');

        /* NodeJS's Buffer has a fixed-size heap allocation.

           Here an Array, which has dynamic allocation,
           is used to buffer (hold) data received from a stream
           then used to construct a Buffer via Buffer.concat(Array),
           a constructor of Buffer. */
        const archiveBuffer = [];

        archive.on('data', chunk => {
          archiveBuffer.push(chunk);
        });
        archive.on('finish', async () => {
          /* Here uploads to S3 are incompatible with streams.
             Chunked Encoding is not supported for uploads
             to a pre-signed url. */
          await request(
            Buffer.concat(archiveBuffer),
            'PUT',
            urlLib.parse(signedRequestURL)
          );
          resolve();
        });

        const filesCount = this.profilerEnabled + this.heapsnapshotEnabled;
        filesSeen = 0;
        archive.on('entry', () => {
          this.log(`Archive received entry [${filesSeen}/${filesCount}]`);
          filesSeen++;
          if (filesSeen >= filesCount) {
            this.log('Last entry. Finalizing archive.');
            archive.finalize();
          }
        });
        if (this.profilerEnabled) {
          this.inspector.post('Profiler.stop', (err, { profile }) => {
            this.log('adding cpuprofile to archive.');
            archive.append(JSON.stringify(profile), {
              name: 'profile.cpuprofile'
            });
          });
        }
        if (this.heapsnapshotEnabled) {
          const heap = new stream.PassThrough();
          this.inspector.on(
            'HeapProfiler.reportHeapSnapshotProgress',
            ([, , finished]) => {
              if (finished) {
                this.log('snapshot completed. closing stream.');
                heap.end();
              }
            }
          );
          this.inspector.on(
            'HeapProfiler.addHeapSnapshotChunk',
            ({ chunk }) => {
              if (chunk) {
                this.log('writing snapshot chunk.');
                heap.write(chunk);
              }
            }
          );
          this.log('Posting takeHeapSnapshot to inspector.');
          this.inspector.post(
            'HeapProfiler.takeHeapSnapshot',
            { reportProgress: true },
            () => {
              this.log('Appending heap snapshot to archive');
              archive.append(heap, { name: 'profile.heapsnapshot' });
              this.log('Appended heap snapshot to archive.');
            }
          );
        }
      } catch (e) {
        this.log(`Error in upload: ${e}`);
        resolve();
      }
    });
  }

  postReport() {
    this.inspector.disconnect();
  }
}

module.exports = function instantiateProfilerPlugin(pluginOpts) {
  return invocationInstance => {
    return new ProfilerPlugin(pluginOpts, invocationInstance);
  };
};
