#!/usr/bin/env node

/*
* Watch on development directory, restart if a file changes
*/

var fs = require('fs-extra');
var nodemailer = require('nodemailer');
var childProcess = require('child_process');
var execSync = require('child_process').execSync;
var spawn = require('child_process').spawn;
var path = require('path');
var transporter = nodemailer.createTransport('smtp://localhost:25');

var action = process.argv[ 2 ];
var p1 = process.argv[ 3 ];
var p2 = process.argv[ 4 ];

var cmd = 'naps';

var usage = `

Naps is the holy grail of node app management when used with NginX as reverse proxy.

Your init script will typically contain:

    naps reset                                   # Clean up
    naps startall forever >> /var/log/naps.log & # Start all apps
    naps watchall         >> /var/log/naps.log & # Restart on change
    naps logcheck         >> /var/log/naps.log & # Email if error log grows

Usage:
    ${cmd} help
    This help screen

    CONFIG OPTIONS

    ${cmd} config or ${cmd} c
    Display all of the config entries

    ${cmd} config write
    Write the expanded nginx config onto the CONF file


    MONITORING OPTIONS

    ${cmd} reset
    Cleans out all lock files in /var/naps used to know what apps are running
    Typically run before 'naps startall forever' at boot time

    ${cmd} list or ${cmd} l
    List all apps, showing the ones that have started


    SINGLE APP MANAGEMENT OPTIONS
    (Output is always timestamped, log-like output)

    ${cmd} start <app-name> [forever]
    Start a specific app. NOTE: all console messages are timestamped and
    paired to the started process.
    If <forever> is passed, naps will monitor the app and make sure that
    it's restarted when needed.
    If the node server outputs one line with 'NAPS: DEAFENING', it's assumed
    that it no longer listens to its assigned port.
    Note that the node instance's logs are in $LOGDIR/$APPNAME-out.log
    and $LOGDIR/$APPNAME-err.log

    ${cmd} stop <app-name>
    Stop a specific app
   
    ${cmd} kill <app-name> [delay]
    Kill a specific app by sending a SIGKILL
    If <delay> is passed, naps will wait <delay> milliseconds before killing

    ${cmd} watch <appname>
    Will watch the app's directory, restart the app if anything changes


    BATCH APP MANAGEMENT OPTIONS
    (Will run naps itself as a background process; will run one different
    naps process per app) 

    ${cmd} startall [forever]
    Start all startable apps

    ${cmd} stopall
    Stop all startable apps

    ${cmd} killall [delay]
    kill all startable apps by sending a SIGKILL

    ${cmd} watchall
    Watch all startable apps marked as 'development'


    MONITORING OPTIONS

    ${cmd} logcheck
    Will check the error logs and inform the admin if more entries are added
    Error logs are assumed to be in $LOGDIR/$APPNAME-err.log


    SYSADMIN OPTIONS
 
    ${cmd} logs <app-name> [err]
    Will show node logs for that app. Will display stdout by default.
    If 'err' is added, it will display the node instance's stderr

    ${cmd} deploy <development-app> <production-app>
    Will overwrite development app onto production one, archiving production
    Files under public/f will be spared

    ${cmd} dbprod2dev <production-app> <development-app>
    Copy database from production app to development. DEVEL DB WILL BE ZAPPED.

    ${cmd} nginx-restart or ${cmd} nr
    Restart nginx

    ${cmd} dbadmin <app>
    Starts a mongo shell on <app>'s database, passing the admin's password
`;

if( !action ){
  console.log( usage );
  process.exit(1);
}

var ts = {
  get d(){
    return (new Date()).toISOString() + ` [${process.pid}]`;
  }
}


// Gorgeous code from https://davidwalsh.name/javascript-debounce-function
function debounce(func, wait, immediate) {
  var timeout;
  return function() {
    var context = this, args = arguments;
      var later = function() {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    var callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(context, args);
  };
};



var Generator = function( inputConfPath ){
  this.mailTo = '';
  this.ip = '';
  this.dir = '/var/www/node-apps';
  this.logdir = '/var/log/naps';
  this.vardir = '/var/naps';
  this.etcdir = '/etc/naps';
  this.portMap = {};
  this.confLines = [];
  this.startableHash = {};
  this.uidGidHash = {};
  this.outputConfFile = '';
  this.dbAdminUserPassword = '';
  this.errorLogs = {};

  try {
    var inputConf = fs.readFileSync( inputConfPath );
  } catch( e ){
    console.log("Could not open config file:", e );
    process.exit(2);
  }

  inputConf.toString().split(/\n/).forEach( ( confLineStr ) => {


    // It's a comment
    if( confLineStr.match(/\s*\#/) || confLineStr.match(/^\s*$/) ) return;

    // Parse it. Lose the original value -- it doesn't matter
    var confLine = confLineStr.match(/\S+/g);

    // Add the line to confLines
    this.confLines.push( confLine );


    // Execute the confLine method
    var method = confLine[ 0 ];

    if( ! this.configGeneratorMethods[ method ] ){
      console.log("Unrecognised method:", method );
      process.exit( 3 );
    }

    var args = confLine.slice( 1 );
    args.unshift( confLine );
    this.outputConfFile += this.configGeneratorMethods[ method ].apply( this, args );
  });
};


Generator.prototype = {

  configGeneratorMethods: {

    DBADMINCREDENTIALS: function( confLine, userPassword ){
      this.dbAdminUserPassword = userPassword;
      return '';
    },

    LOGDIR: function( confLine, logdir ){
      this.logdir = logdir; 
      if( ! fs.existsSync( logdir) ) fs.mkdirSync( logdir );
      return '';
    },

    VARDIR: function( confLine, vardir ){
      this.vardir = vardir; 
      if( ! fs.existsSync( vardir) ) fs.mkdirSync( vardir );
      return '';
    },


    APPSDIR: function( confLine, dir ){
      this.dir = dir; 
      return '';
    },

    ETCDIR: function( confLine, etcdir ){
      this.etcdir = etcdir; 
      return '';
    },


    MAILFROM: function( confLine, mailFrom ){
      this.mailFrom = mailFrom; 
      return '';
    },

    MAILTO: function( confLine, mailTo ){
      this.mailTo = mailTo; 
      return '';
    },


    N: function( confLine, n ){
      this.n = n; 
      return '';
    },
 
    CONF: function( confLine, conf ){
      this.conf = conf; 
      return '';
    },
 
    RUN: function(confLine, appName, port ){
      if( port === 'N++' ){
        confLine[ 2 ] = port = this.n++;
      }
   
      this.portMap[ appName ] = port; 


      if( this.startableHash[ confLine[ 1 ] ] ){
        console.log("Duplicate appName as RUN:", confLine[ 1 ] );
        process.exit( 6 );
      }

      this.startableHash[ confLine[ 1 ] ] = confLine;

      // Yes they can be duplicated, and definitely will be
      this.uidGidHash[ confLine[ 4 ] ] = confLine;


      // Expand confLine[6] to basic env + JSON.parse'd env
      var env = {
        NODE_ENV: confLine[ 3 ], //production
        APPNAME: confLine[ 1 ], // gigsnet
        DBHOST: confLine[ 5 ], // merc:merc@localhost
        DBNAME: confLine[ 1 ], // gigsnet
        IPADDRESS: 'localhost',
        PORT: confLine[ 2 ], // 8080
        SERVER: 'server.js',
      };

      if( confLine[ 6 ] ){
        try {
          var extraEnv = JSON.parse( confLine[ 6 ] );
        } catch( e ){
          console.log("Error parsing extra env for " + confLine[ 1 ] + ": ", e );
          process.exit(9);
        }
        for( var k in extraEnv ){
          env[ k ] = extraEnv[ k ];
        }
      }

      confLine[ 6 ] = env;

      this.errorLogs[ env.APPNAME ] = `${this.logdir}/${env.APPNAME}-err.log`

      return '';
    },
  

    SET_IP: function( confLine, ip ){
      this.ip = ip;
      return '';
    },

    REDIRECT_HTTP_TO_HTTPS: function( confLine, fromHost, toHost ){
      var ip = this.ip;
      return `
  
        # REDIRECT_HTTP_TO_HTTPS, ${fromHost}, ${toHost}
  
        server {
            listen       ${ip}:80;
            server_name ${fromHost};
            return 301 https:\/\/${toHost}\$request_uri;
        }
      `;
    },
  
    PROXY_HTTP_TO_LOCAL_PORT: function( confLine, host, appName ){
      var ip = this.ip;
      var port = this.portMap[ appName ];
      return `
  
        # PROXY_HTTP_TO_LOCAL_PORT, ${host}, ${port}
  
        server {
            listen ${ip}:80;
            server_name ${host};
  
            client_max_body_size 0;
  
            location / {
  
              proxy_pass http:\/\/localhost:${port};
              #proxy_http_version 1.1;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection 'upgrade';
              proxy_set_header Host $host;
              proxy_cache_bypass $http_upgrade;
            }
        }
  
      `;
    },
  
  
    PROXY_HTTPS_TO_LOCAL_PORT: function( confLine, host, appName, certType ){
      var ip = this.ip;
      var port = this.portMap[ appName ];

      var certSection;
      if( certType == 'letsencrypt' ){
         certSection = `
            ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;
            ssl_trusted_certificate /etc/letsencrypt/live/${host}/chain.pem;
            ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
            ssl_dhparam /etc/nginx/ssl/dhparam.pem;
            ssl_stapling on;
            ssl_stapling_verify on;
         `;         
      };
      if( certType == 'local' ){
         certSection = `
            ssl_certificate /etc/nginx/ssl/${host}.crt;
            ssl_dhparam /etc/nginx/ssl/dhparam.pem;
            ssl_certificate_key /etc/nginx/ssl/${host}.key;
         `;         
      }

      return `
  
        # PROXY_HTTPS_TO_LOCAL_PORT, ${host}, ${port}
  
        server {
            listen ${ip}:443 ssl http2;
            server_name ${host};
  
            client_max_body_size 0;

            ${certSection}
  
  
            location / {
  
              proxy_pass http:\/\/localhost:${port};
              proxy_http_version 1.1;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection 'upgrade';
              proxy_set_header Host $host;
              proxy_cache_bypass $http_upgrade;
            }
        }
  
      `;
    },
  
    REDIRECT_BOTH_TO_HTTPS: function( confLine, fromHost, toHost, certType ){
      var ip = this.ip;

      var certSection;
      if( certType == 'letsencrypt' ){
         certSection = `
            ssl_certificate /etc/letsencrypt/live/${fromHost}/fullchain.pem;
            ssl_trusted_certificate /etc/letsencrypt/live/${fromHost}/chain.pem;
            ssl_certificate_key /etc/letsencrypt/live/${fromHost}/privkey.pem;
            ssl_dhparam /etc/nginx/ssl/dhparam.pem;
            ssl_stapling on;
            ssl_stapling_verify on;
         `;
      };
      if( certType == 'local' ){
         certSection = `
            ssl_certificate /etc/nginx/ssl/${fromHost}.crt;
            ssl_dhparam /etc/nginx/ssl/dhparam.pem;
            ssl_certificate_key /etc/nginx/ssl/${fromHost}.key;
         `;
      }

      return `
  
        # REDIRECT_BOTH_TO_HTTPS, ${fromHost}, ${toHost}
  
        server {
            listen       ${ip}:80;
            server_name ${fromHost};
            return 301 https:\/\/${toHost}\$request_uri;
        }
  
        server {
            listen       ${ip}:443 ssl;
            server_name ${fromHost};

            ${certSection}

            return 301 https:\/\/${toHost}\$request_uri;
        }
      `;
    },
  },


  _generateConfigFile: function(){

    if( !this.conf ){
      console.log("CONF directive needed to generate config file" );
      process.exit( 7 );
    }

    try {
      fs.writeFileSync( this.conf, this.outputConfFile );
      console.log("\nNginx config file written as: ", this.conf );
    } catch( e ){
      console.log("Could not write output config file: ", e );
      process.exit(8);
    }

  },

  start: function( confLine, forever, pid ){

    var allChildrenPids = [];


    // IMPORTANT FLAGS that share the scope with actualStart()
    var processLeaderQuitting = false;
    var restartOnceCard = false;

    var env = confLine[ 6 ];
    var appName = env.APPNAME;
    var self = this;


    process.on('uncaughtException', function( err ) {
      console.log( `${ts.d} ${appName} [start] [main] -> uncaught exception!`, err);
      sendTermToAllChildren('quit');
    });

    process.on('SIGTERM', function() {
      console.log( `${ts.d} ${appName} [start] [main] -> SIGTERM received, passing SIGTERM on to all children`);
      sendTermToAllChildren('quit');
    });

    process.on('SIGUSR2', function() {
      console.log( `${ts.d} ${appName} [start] [main] -> SIGUSR2 received, passing SIGTERM on to all children`);
      sendTermToAllChildren('restart');
    });
 
    process.on('SIGINT', function() {
      console.log( `${ts.d} ${appName} [start] [main] -> SIGINT received, passing SIGTERM on to all children`);
      sendTermToAllChildren( 'quit');
    });
 

    function sendTermToAllChildren( action ){
      if( processLeaderQuitting ){
         console.log( `${ts.d} ${appName} [start] [main] -> Not terminating children since they have already been terminated`);
         return;
      }

      // Sets the right flag: one to determine the end of the leader, the other to allow a restart
      if( action == 'quit' ) processLeaderQuitting = true;
      if( action == 'restart' )  restartOnceCard = true;

      console.log( `${ts.d} ${appName} [start] [main] -> Terminating ${allChildrenPids.length} children` );


      allChildrenPids.forEach( function( pid ){
        console.log( `${ts.d} ${appName} [start] [main] -> Sending SIGTERM to ${pid}`);
        try {
          process.kill( pid, 'SIGTERM' );
        } catch( e ){
          console.log(`${ts.d} ${appName} [start] [main] -> Error sending SIGTERM signal:`, e );
        }
      });
    }

    actualStart( confLine, forever, pid );


    foreverRestartDelay = 0;
    function actualStart( confLine, forever, pid ){

      var deaf = false;
      var child;
  
 
      var running;
  
      var lid = pid ? `${appName} [start] [${pid}] -> ` : `${appName} [start] [no pid] ->`;
  
      console.log(`${ts.d} ${lid} STARTING: ${appName}` );
      if( forever ) console.log(`${ts.d} ${lid} Running app, making sure it's respawn when needed...`);
  
      var pidFile = `${self.vardir}/${env.APPNAME}`;
      console.log(`${ts.d} ${lid} PID file for this starting instance is ${pidFile}` );

      try { 
        running = fs.existsSync( pidFile );
      } catch( e ) {
        console.log(`${ts.d} ${lid} Error checking if naps process file exists:`, e );
        return;
      }
  
      console.log(`${ts.d} ${lid} Checked for:`, pidFile );
      if( running ){
  
        try { 
          var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
        } catch( e ) {
          console.log(`${ts.d} ${lid} Error reading the pid file for the process:`, e );
          return;
        }
  
        try { 
          var pid = pidInfo[ 1 ];
          running = fs.existsSync(`/proc/${pid}` );
        } catch( e ) {
          console.log(`${ts.d} ${lid} Error checking if process file exists:`, e );
          return;
        }
      
        if( running ) {
          console.log(`${ts.d} ${lid} Cannot run process ${env.APPNAME} as the process is already running (PID: ${pid})`);
          return;
        } else {
  
          try { 
            fs.unlinkSync( pidFile );
          } catch( e ) {
            console.log(`${ts.d} ${lid} Error deleting the pid file (process wasn't there):`, e );
            return;
          }
   
        }
      }
      console.log(`${ts.d} ${lid} App ${env.APPNAME} isn't already started, starting it now...`);
  
      // Work out gid and uid
      var uidGid = confLine[ 4 ].split( /:/ );
      var uid = Number( uidGid[ 0 ] );
      var gid = Number( uidGid[ 1 ] );
     
      // Work out cwd
      var cwd = path.join( self.dir, env.APPNAME );
  
      var lp = env.APPNAME;
      var server = env.SERVER;
  
      console.log(`${ts.d} ${lid} Starting ` + confLine[ 1 ] + " in directory", cwd, "with gid and uid", gid, uid );
      
      try {
        var out = fs.createWriteStream(`${self.logdir}/${lp}-out.log`, { flags: 'a', defaultEncoding: 'utf8' } );
        var err = fs.createWriteStream(`${self.logdir}/${lp}-err.log`, { flags: 'a', defaultEncoding: 'utf8' } );
        child = childProcess.spawn( '/usr/bin/node', [ server ], { env: env, uid: uid, gid: gid, cwd: cwd, detached: true } );
      } catch( e ) {
        console.log(`${ts.d} ${lid} Could not run node:`, e );
        return;
      }
  
      // ***************************************************************
      // ******** CHILD/EVENTS MANAGEMENT STARTS HERE ******************
      // ***************************************************************
  
      child.stdout.on('data', function( data ){
  
        try { 
          // The child process has stopped dealing with incoming connections.
          // For all intents and purposes, the process is useless and dead
          if( data.toString().match( /^NAPS: DEAFENING$/m ) ){
            console.log(`${ts.d} ${lid} The child process has stopped taking connections!`);
            movePidAsDeaf();
            maybeRestart();    
          }
          var pre = (new Date()).toISOString() + ' [' + child.pid + '] ';
          out.write( Buffer.from( data.toString().trim().split("\n").map( (l,i) => { return pre + l }) .join('\n') + '\n' ));
        } catch( e ){
          console.log(`${ts.d} ${lid} Error while redirecting stream to standard output!`, e );
        }
      });
      child.stderr.on('data', function( data ){
        try {
          var pre = (new Date()).toISOString() + ' [' + child.pid + '] ';
          err.write( Buffer.from( '\n' + data.toString().trim().split("\n").map( (l) => { return pre + l }) .join('\n') ));
        } catch( e ){
          console.log(`${ts.d} ${lid} Error while redirecting stream to standard error!`, e );
        }
      });
  
      child.once( 'exit', function(){
        console.log(`${ts.d} ${lid} Child for app ${env.APPNAME} exited`);
        deletePidFile();
        allChildrenPids = allChildrenPids.filter( (v) => { return v != child.pid } );
        if( ! deaf ) maybeRestart();
        else console.log(`${ts.d} ${lid} Not restarting the app since it was deaf`);
        child.unref();
      });
 
      // This will allow us to kill them all later
      allChildrenPids.push( child.pid );

      // *************************************************
      // ************ WRAPPING UP       ******************
      // *************************************************

      // Now that the child PID has changed, the lid will have to change too
      var oldLid = lid;
      lid = `${appName} [start] [${child.pid}]`;
  
      try { 
        fs.writeFileSync( pidFile, `${env.APPNAME}:${child.pid}:${process.pid}` );
      } catch( e ) {
        console.log(`${ts.d} ${lid} Error creating pid file for process. This WILL cause problems`, e );
      }
  
      console.log(`${ts.d} ${oldLid} [${child.pid}] Success!`);
      console.log(`${ts.d} ${lid} Let the fun begin!`);
  
      // *************************************************
      // ************ SUPPORT FUNCTIONS ******************
      // *************************************************
  
      // DELETE PID, WHEREVER IT IS
      var deletePidFile = function(){
        try { 
          console.log(`${ts.d} ${lid} Cleaning up pid file for ` + env.APPNAME, 'as:', pidFile );
          fs.unlinkSync( pidFile );
        } catch( e ) {
          console.log(`${ts.d} ${lid} Error cleaning up ${env.APPNAME}:`, e );
        }
      }
  
      // RESTART IF FOREVER IS ON
      var maybeRestart = function( ){

        console.log( `${ts.d} ${lid} Maybe restarting ${appName} depending on processLeaderQuitting (${processLeaderQuitting}), forever (${forever}) and restartOnceCard (${restartOnceCard}) ` );

        if( processLeaderQuitting ){
          console.log(`${ts.d} ${lid} NOT restarting ${appName} since the main process is quitting` );
          return;
        }

        if( forever || restartOnceCard  ){
          console.log(`${ts.d} ${lid} Restarting ${appName}` + ( restartOnceCard ? " (Process wants to be restarted)" : '' ) );

          // Restart either immediately or after a small break
          if( restartOnceCard ){
            actualStart( confLine, forever, child.pid );
            restartOnceCard = false;
            foreverRestartDelay = 0;
          } else {
            var inSeconds = Math.floor( foreverRestartDelay / 1000 );
            console.log(`${ts.d} ${lid} This is a 'forever' restart: delaying restart by ${inSeconds} seconds`);
            setTimeout( function(){ 
              actualStart( confLine, forever, child.pid );
              foreverRestartDelay = foreverRestartDelay + 4000;
            }, foreverRestartDelay );
          }
        }
      };
  
      // TURN PID AS DEAF
      var movePidAsDeaf = function(){
        if( deaf ){
          console.log(`${ts.d} ${lid} this instance is already deaf`);
          return;
        }

        var newPidFile = `${self.vardir}/deaf/${child.pid}`
        console.log(`${ts.d} ${lid} Moving ${pidFile} to ${newPidFile}`);
        try {
          fs.moveSync( pidFile, newPidFile, { overwrite: true } );
        } catch( e ){
          console.log(`${ts.d} ${lid} Could NOT move the pid file into the 'deaf' zone: this will create problems`);
          return;
        }
        pidFile = newPidFile;
        deaf = true;
      }
    } 

  },

  watch: function( confLine, quiet ){
 
    var env = confLine[ 6 ];
    var appName = confLine[ 1 ];
    var appDir = `${this.dir}/${env.APPNAME}`;

 
    var lastEvent = new Date();
    console.log(`${ts.d} [watch] [main] -> Watching changes in ${appName} (in ${appDir}` );
    fs.watch( appDir, {}, debounce( function( type, file ){
      console.log(`${ts.d} [watch] [main] -> Change detected. Restarting server` );

      generator.stop( confLine, 'restart' );
    }, 1000 ));
  },


  stop: function( confLine, action, delay ){
 
    var env = confLine[ 6 ];
    var appName = confLine[ 1 ];
    var pidFile = `${this.vardir}/${env.APPNAME}`;

    var signals = {
      stop: 'SIGTERM',
      restart: 'SIGUSR2',
      kill: 'SIGKILL',
    };


    var signal = signals[ action ];

    try { 
      running = fs.existsSync( pidFile );
    } catch( e ) {
      console.log(`${ts.d} [${action}] [main] -> Error checking if process file exists:`, e );
      if( exitOnFail) process.exit(9);
      return;
    }

    if( !running ){
      console.log( `${ts.d} [${action}] [main] -> App ${appName} is not running`);
      return;
    }

    console.log( `${ts.d} [${action}] [main] -> Executing ${action} on parent of ${confLine[ 1 ]}` );
    if( action == 'kill' ) console.log(`${ts.d} [${action}] [main] -> Since it's a kill request, ${confLine[ 1 ]} will also get SIGKILL` );


    // If the file is there...
    try {
      running = fs.existsSync( pidFile );
    } catch( e ){
     console.log(`Error checking if process file exists:`, e );
    }

    if( running ) {
      try {
        var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
       } catch( e ) {
       console.log(`${ts.d} [${action}] [main] -> Error reading the pid file for the process:`, appName, e );
       running = false;
       }

       if( running ) {
        try {
          var pid = pidInfo && pidInfo[ 1 ];
          if( pid )  running = fs.existsSync(`/proc/${pid}` );
        } catch( e ) {
          console.log(`Error checking if process file exists:`, e );
          running = false;
        }
      }
    }

    if( !running ){
      console.log(`${ts.d} [${action}] [main] -> App ${appName} is not running, ${action} aborted`);
      return;
    }


    try { 
      var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
    } catch( e ) {
      console.log(`${ts.d} [${action}] [main] -> Error reading the pid file for the app ${appName}:`, e );
      return;
    }

    // Send signals, MAYBE with a delay
    var execute = function(){
      try {
        process.kill( pidInfo[ 2 ], signal );
        if( action == 'kill' ) process.kill( pidInfo[ 1 ], signal );
      } catch( e ){
        console.log(`${ts.d} [${action}] [main] -> Error sending signal:`, e );
      }
    }
    if( delay ){
      console.log(`${ts.d} [${action}] [main] -> Kill request will be delayed as requested` );
      setTimeout( function(){
        execute();
        console.log(`${ts.d} [mainstop] -> Successful executed ${signal} on ${appName}` );
      }, delay );
    } else {
      execute();
      console.log(`${ts.d} [${action}] [main] -> Successful executed ${signal} on ${appName}` );
    }

  },


  list: function( uidGidString ){

    vardir = this.vardir;

    console.log("");
    console.log("Apps:");
    console.log("-----");

    // Show list of startable server, showing command, port and 
    generator.confLines.forEach( (confLine) => {
      if( confLine[ 0 ] == 'RUN' ){

        var running = false;

        var appName = confLine[ 1 ];
        var pidFile = `${vardir}/${appName}`;

        // If the file is there...
        try {
          running = fs.existsSync( pidFile );
        } catch( e ){
         console.log(`Error checking if process file exists:`, e );
        }

        if( running ) {
          try { 
            var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
          } catch( e ) {
           console.log("Error reading the pid file for the process:", appName, e );
           running = false;
          }

          if( running ) {
            try { 
              var pid = pidInfo && pidInfo[ 1 ];
              if( pid )  running = fs.existsSync(`/proc/${pid}` );
            } catch( e ) {
              console.log(`Error checking if process file exists:`, e );
              running = false;
            }
          }
        }
        var runningConsoleLog = running ? `running as ${pid} and managed by ${pidInfo[2]}` : 'NOT RUNNING';
        console.log( `${confLine[ 1 ]}:${confLine[ 2 ]} [${confLine[ 3 ]}] ${runningConsoleLog}` );
      }
    });


    var vardir = this.vardir;
    var startableHash = this.startableHash;

    try {
      var deafAppPidFiles = fs.readdirSync( `${this.vardir}/deaf` );
    } catch( e  ){
      console.log("Could not read directory:", this.vardir );
      process.exit(9);
    }

      
    console.log("");
    console.log("Deaf processses:");
    console.log("----------------");

    var foundOne = false;
    deafAppPidFiles.forEach( ( deafAppPidFile ) => {
      var pidInfo;

       try { 
        var pidInfo = fs.readFileSync( `${this.vardir}/deaf/${deafAppPidFile}` ).toString().split(':');
      } catch( e ) {
        console.log("Error reading the pid file for the process:", e );
        return;
      }
    
      try {
        var pid = pidInfo[ 1 ];
        running = fs.existsSync('/proc/' + pid);
      } catch( e ) {
        console.log("Error checking if process file exists:", e );
        return;
      }

      // It IS actually running!
      if( running ){
        var deafAppName = pidInfo[0];  
        var confLine = startableHash[ deafAppName ];
        console.log( `${confLine[ 1 ]}:${confLine[ 2 ]} [${confLine[ 3 ]}] running as ${pidInfo[1]} and managed by ${pidInfo[2]}` );
        foundOne = true;
      }
    });


    if( !foundOne) console.log("NO deaf processes");
    process.exit( 0 );
  },


  logcheck: function(){

    var startableHash = this.startableHash;
    var mailFrom = this.mailFrom;
    var mailTo = this.mailTo;

    Object.keys( this.errorLogs ).forEach( (appName) => {
      var logFile = this.errorLogs[ appName ];

      console.log(`[${appName}] Keeping an eye on`, logFile );

      // Get the file's length
      var size;
      try { size =  fs.statSync( logFile ).size; } catch ( e ) { size = 0 };
      var dealingWithChange = false;
      var muteEmails = false;

      console.log(`[${appName}] Current size:`, size );

      var fsHandle = fs.watch( logFile, function dealer( eventType ){

        if( eventType != 'change' ) return;

        var later = dealingWithChange || muteEmails ? "Will manage later": "Managing change in exactly 1 second";
        console.log(`[${appName}] Log file for ${appName} (${logFile} changed...`);
        console.log(`[${appName}] Dealing with changes right now:`, dealingWithChange, "Emails muted:", muteEmails, later );

        // Do noting if it's the wrong event type or if dealing with change as we speak
        if( dealingWithChange || muteEmails ){
           return;
        }

        // This will prevent further action
        dealingWithChange = true;
        muteEmails = true;
       
        // Emails are un-muted automatically
        setTimeout( function(){
          console.log(`[${appName}] Unmuting emails, and checking that the file hasn't changed in the meantime...`);
          muteEmails = false;
          
          var newSize;
          try { newSize =  fs.statSync( logFile ).size; } catch ( e ) { size = 0 };
          if( size != newSize ){
            console.log(`[${appName}] While the emails were muted, the file has grown further. Re-running function` );
            dealer('change');
          } else {
            console.log(`[${appName}] File size is the same since unmuting emails, all good.` );
          }

        }, 10000 );

        // File has changed: will need to send an email

        // Wait 4 seconds to give it time to the log to fill up
        setTimeout( function(){

          var newSize;

          // Set the new size for the next time it's watched
          try { newSize =  fs.statSync( logFile ).size; } catch ( e ) { size = 0 };

          try {
            var contents = new Buffer( newSize - size );
            var fd = fs.openSync( logFile, 'r+' );
            fs.readSync( fd, contents, 0, newSize - size, size );
          } catch( e ){
            console.log(`[${appName}] Couldn't read the log file:`, e );
            dealingWithChange = false;
            return;
          }

          console.log(`[${appName}] Emailing: `, contents.toString() );

          // setup e-mail data with unicode symbols
          var mailOptions = {
            from: `"${mailFrom} 👥" <${mailFrom}>`, // sender address
            to: mailTo,
            subject: `${appName}: Error log grew`,
            text: contents.toString(),
          };

          // send mail with defined transport object
          transporter.sendMail(mailOptions, function (err, info) {

            // In case of errors, simply log it
            if (err){
              console.log(`[${appName}] FAILED sending an email!`, err );
            } else {
              console.log(`[${appName}] Email successfully dispatched` );
            }

            size = newSize;
            dealingWithChange = false;
         });

        }, 2000 );

      });

    });
  },

};
Generator.constructur = Generator;


// Read the config file
var generator = new Generator('/etc/naps.conf');


switch( action ){


  case 'list':
  case 'l':
    generator.list();
  break;


  case 'config':
  case 'c':

    if( p1 && ( p1 != 'write' ) ){
      console.log("Usage: configurer.js list [write]");
      process.exit(1);
    }

    // Show the full config
    generator.confLines.forEach( (confLine) => {
      console.log( confLine.join(' '));
    });

    // Write the config file if so requested
    if( p1 == 'write' ){
      generator._generateConfigFile();
    }
  break;

  case 'stop':
  case 'restart':
  case 'kill':

    if( !p1 ){
      console.log( usage );
      process.exit( 5 );
    }

     if( p2 && ( action != 'kill' ) ){
      console.log( "Delay can only be specified with 'kill'" );
      console.log( usage );
      process.exit(1);
    }


    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log( `${ts.d} [${action}] [main] -> Startable server not found:`, p1 );
      process.exit( 5 );
    }

    console.log( `${ts.d} [${action}] [main] -> Operation requested: `, action );

    generator.stop( confLine, action, p2 );
 
  break;


  case 'watch':
     if( !p1 ){
      console.log( usage );
      process.exit( 5 );
    }

    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log("Startable server not found:", p1 );
      console.log( "Use the 'list' parameters for the list of apps" );
      process.exit( 5 );
    }

    generator.watch( confLine );
 break;

  case 'start':
   

    if( !p1 ){
      console.log( usage );
      process.exit( 5 );
    }

     if( p2 && ( p2 != 'forever' ) ){
      console.log( usage );
      process.exit(1);
    }

    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log("Startable server not found:", p1 );
      console.log( "Use the 'list' parameters for the list of apps" );
      process.exit( 5 );
    }


    generator.start( confLine, p2 == 'forever' );

  break;

  case 'startall':

    if( p1 && ( p1 != 'forever' ) ){
      console.log( usage );
      process.exit(1);
    }

    if( p1 == 'forever' && action == 'stopall' ){
      console.log("The [forever] option will only work for start and startall");
      process.exit(1);
    }


    arg = p1 || '';


    console.log( `${ts.d} [main] [startall] -> STARTALL INVOKED. Starting all in 30 seconds...` );

    var gap = 5000;

    setTimeout( function(){

      Object.keys( generator.startableHash ).forEach( (appName ) => {
        var confLine = generator.startableHash[ appName ];

        setTimeout( function(){ 
          console.log( `${ts.d} [main] [startall] -> Starting ${appName}` );
          try { 
            spawn('naps', ['start', appName, arg ], { stdio: [ 'ignore', process.stdout, process.stderr ], detached: true }).unref();
          } catch( e ){
            console.log("ERROR:", e );
          }
        }, gap);
        gap += 5000;

      });
    }, 30000 );


  break;


  case 'stopall':

    Object.keys( generator.startableHash ).forEach( (appName ) => {
      console.log( `${ts.d} [main] [stopall] -> Stopping ${appName}`);
      spawn('naps', ['stop', appName ], { stdio: [ 'ignore', process.stdout, process.stderr ], detached: true }).unref();
    });    

  break;

  case 'killall':

    Object.keys( generator.startableHash ).forEach( (appName ) => {
      console.log( `${ts.d} [main] [killall] -> Killing ${appName}`);
      spawn('naps', ['kill', appName, p1 ], { stdio: [ 'ignore', process.stdout, process.stderr ], detached: true }).unref();
    });    

  break;

  case 'watchall':

    Object.keys( generator.startableHash ).forEach( (appName ) => {
      var confLine = generator.startableHash[ appName ];
      if( confLine[ 3 ] == 'development' ){
        console.log( `${ts.d} [main] [watchall] -> Watching ${appName}`);
        spawn('naps', ['watch', appName ], { stdio: [ 'ignore', process.stdout, process.stderr ], detached: true }).unref();
      }
    });    

  break;



  case 'reset':
   execSync(`rm -f /var/naps/deaf/*`);
   Object.keys( generator.startableHash ).forEach( (appName ) => {
      console.log(`Deleting ${appName}`);
      execSync(`rm -f /var/naps/${appName}`);
    });    
  break;


  case 'config':
  break;

  case 'deploy':

    var j = path.join;

    if( ! generator.startableHash[ p1 ] ){
      console.log("development-app needs to be a startable entry:", p1 );
      process.exit( 9 );
    }

    if( ! generator.startableHash[ p2 ] ){
      console.log("production-app needs to be a startable entry:", p2 );
      process.exit( 10 );
    }

    if( generator.startableHash[ p1 ][3] != 'development' ){
      console.log("development-app needs to be a DEVELOPMENT environment. It is:", generator.startableHash[ p1 ][3] );
      process.exit( 13 );
    }

    if( generator.startableHash[ p2 ][3] != 'production' ){
      console.log("production-app needs to be a PRODUCTION entry. It is:", generator.startableHash[ p2][3] );
      process.exit( 14 );
    }


    var p = generator.dir;
    var now = new Date().toISOString();
    
    if( ! p ){
      console.log("DIR directive is missing in naps.conf" );
      process.exit( 10 );
    }

    var develPath = j( p, p1 );
    var productionPath = j( p, p2 );

    if( ! fs.existsSync( develPath )){
      console.log("development-app needs to be a startable entry:", p1 );
      process.exit( 11 );
    }

    if( ! fs.existsSync( productionPath )){
      console.log("production-app needs to be a startable entry:", p2 );
      process.exit( 12 );
    }

    var s,d;


    console.log("Exiting early, this deployment procedure sucks");
    process.exit( 0 );

    console.log("Archiving away public files in development environment...");
    s = j( develPath, "/public/f");
    d = j( p, '_archived', "f." + p1 + '.' + now );
    execSync(`mv ${s} ${d}`);

    console.log("Moving public files from production to development (it will be production soon)...");
    s = j( productionPath, "/public/f");
    d = j( develPath, "/public/f");
    execSync(`mv ${s} ${d}`);

    console.log("Archiving away old production folder...");
    s = productionPath;
    d = j( p, '_archived', p2 + '.' + now );
    execSync(`mv ${s} ${d}`);

    console.log("Turning current development environment (now with production files) into production...");
    s = develPath;
    d = productionPath;
    execSync(`mv ${s} ${d}`);

    console.log("Making up a new development environment based on the production one...");
    s = productionPath;
    d = develPath;
    execSync(`cp -prH ${s} ${d}`);

    console.log("Renaming .git/config into .git/config-DEPLOYED in production, no more commits");
    s = j(productionPath, '.git','config');
    d = j(productionPath, '.git', 'config-DEPLOYED' );
    execSync(`mv ${s} ${d}`);

    console.log("Executing post-deployment script if needed..." );
    s = `${generator.etcdir}/${p2}.postdeploy`;
    console.log("Script is: "+ s );

    if( fs.existsSync( s ) ) console.log( execSync( s ).toString()  );
    else console.log("Script not there, skipping!");

    console.log("DEPLOY DONE!");
  break;

  case 'dbprod2dev':


    if( ! generator.startableHash[ p1 ] ){
      console.log("production-app needs to be a startable entry:", p1 );
      process.exit( 10 );
    }

    if( ! generator.startableHash[ p2 ] ){
      console.log("development-app needs to be a startable entry:", p2 );
      process.exit( 9 );
    }

    if( generator.startableHash[ p1 ][3] != 'production' ){
      console.log("production-app needs to be a PRODUCTION entry. It is:", generator.startableHash[ p1 ][3] );
      process.exit( 14 );
    }

    if( generator.startableHash[ p2 ][3] != 'development' ){
      console.log("development-app needs to be a DEVELOPMENT environment. It is:", generator.startableHash[ p2 ][3] );
      process.exit( 13 );
    }

    var fromDb = generator.startableHash[ p1 ][5].DBNAME;
    if( ! fromDb ){
      console.log("production-app doesn't have a DBNAME set" );
      process.exit( 15 );
    }

    var toDb = generator.startableHash[ p2 ][5].DBNAME;
    if( ! toDb ){
      console.log("development-app doesn't have a DBNAME set" );
      process.exit( 16 );
    }

    console.log("Dropping devel database...");
    execSync(`mongo ${p2} --eval "db.dropDatabase()"`);

    console.log("Copying current development db over production...");
    execSync(`mongo --eval "db.copyDatabase( '${fromDb}', '${toDb}' )"`);
 
    console.log("OK!");

    // Work out DBs based on 
  break;


  case 'nginx-restart':
  case 'nr':
    console.log("Restarting nginx...");
    execSync(`service nginx restart`);
  break;


  case 'dbadmin':
    var up = generator.dbAdminUserPassword.split(':');
    var user = up[ 0 ];  
    var password = up[ 1 ];  


    // Check that the entry is a startable process
    var confLine = generator.startableHash[ p1 ];
    if( !confLine ) {
      console.log(`${p1} needs to be a startable entry:`, p1 );
      process.exit( 9 );
    }

    var db = confLine[ 6 ].DBNAME;

    var args = ['-u', user, '-p', password, '--authenticationDatabase', 'admin', db ];
    console.log("Running: mongo " +  args.join(' ' ) );
    spawn('mongo', ['-u', user, '-p', password, '--authenticationDatabase', 'admin', db ], {stdio: 'inherit', shell: true});
  break;

  case 'logs':

    if( !p1 ){
      console.log( usage );
      process.exit( 5 );
    }

    if( p2 && ( p2 != 'err' ) ){
      console.log( usage );
      process.exit(1);
    }

    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log("Startable server not found:", p1 );
      console.log( "Use the 'list' parameters for the list of apps" );
      process.exit( 5 );
    }

    // 'out' by default
    p2 = p2 || 'out';

    var logFile = `${generator.logdir}/${p1}-${p2}.log`;

    var child = spawn('less', [logFile], {stdio: 'inherit', shell: true, detached: true });


    // Prevent SIGINT from killing this process
    process.on( 'SIGINT', function(){
      process.kill( child.pid, 'SIGINT' );
    } );
  break;





  case 'logcheck':
    generator.logcheck();
  break;

  default:
    console.log( usage );
    process.exit( 3 );
  break;
}


