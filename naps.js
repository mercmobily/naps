#!/usr/bin/env node

/*
* Add timestamp, uid and appName to output of child processes, and check for "SERVER HAS STOPPED" at the same time
* Watch on development directory, restart if a file changes
*/

var fs = require('fs-extra');
var nodemailer = require('nodemailer');
var childProcess = require('child_process');
var execSync = require('child_process').execSync;
var spawn = require('child_process').spawn;
var path = require('path');
var transporter = nodemailer.createTransport('smtp://localhost:25');

require('console-stamp')(console, '[mmm-dd-yyyy HH:MM:ss HH:MM:ss.l]');

var action = process.argv[ 2 ];
var p1 = process.argv[ 3 ];
var p2 = process.argv[ 4 ];

var cmd = 'naps';

var usage = `
Usage:
    ${cmd} help
    This help screen

    ${cmd} config or ${cmd} c
    Display all of the config entries

    ${cmd} config write
    Write the expanded nginx config onto the CONF file

    ${cmd} startable or ${cmd} l
    List all apps that can be started

    ${cmd} started or ${cmd} s
    List all apps currently running

    ${cmd} startall [forever]
    Start all apps that can be started. 

    ${cmd} stopall
    Stop all apps

    ${cmd} start <app-name> [forever]
    Start a specific app
    If 'forever' is passed, naps will monitor the app and make sure that it's restarted when needed

    ${cmd} stop <app-name>
    Start a specific app
    
    ${cmd} deploy <development-app> <production-app>
    Will overwrite development app onto production one, archiving the current production one.
    Files under public/f will be spared

    ${cmd} dbprod2dev <production-app> <development-app>
    Copy database from production app to development app. DEVEL DB WILL BE ZAPPED.

    ${cmd} nginx-restart or ${cmd} nr
    Restart nginx

    ${cmd} dbadmin <app>
    Starts a mongo shell on <app>'s database, passing the admin's password

    ${cmd} logcheck
    Will check the error logs and inform the admin if more entries are added
`;

if( !action ){
  console.log( usage );
  process.exit(1);
}


var Generator = function( inputConfPath ){
  this.mailTo = '';
  this.ip = '';
  this.dir = '/var/www/node-apps';
  this.logdir = '/var/log/naps';
  this.vardir = '/var/naps';
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

    DBADMIN: function( confLine, userPassword ){
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


    DIR: function( confLine, dir ){
      this.dir = dir; 
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

  start: function( confLine, forever ){

    var self = this;
    var dead = false;

    var env = confLine[ 6 ];

    var running;

    var pidFile = `${this.vardir}/${env.APPNAME}`;
    try { 
      running = fs.existsSync( pidFile );
    } catch( e ) {
      console.log("Error checking if naps process file exists:", e );
      return;
    }

    console.log("Checked for:", pidFile );
    if( running ){

      try { 
        var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
      } catch( e ) {
        console.log("Error reading the pid file for the process:", e );
        return;
      }

      try { 
        var pid = pidInfo[ 1 ];
        running = fs.existsSync(`/proc/${pid}` );
      } catch( e ) {
        console.log("Error checking if process file exists:", e );
        return;
      }
    
      if( running ) {
        console.log(`Cannot run process ${env.APPNAME} as the process is already running`);
        return;
      } else {

        try { 
          fs.unlinkSync( pidFile );
        } catch( e ) {
          console.log("Error deleting the pid file (process wasn't there):", e );
          return;
        }
 
      }
    }

    console.log("RUNNING:", confLine );

    // Work out gid and uid
    var uidGid = confLine[ 4 ].split( /:/ );
    var uid = Number( uidGid[ 0 ] );
    var gid = Number( uidGid[ 1 ] );
   
    // Work out cwd
    var cwd = path.join( this.dir, env.APPNAME );

    var lp = env.APPNAME;
    var server = env.SERVER;
    var appName = env.APPNAME;
    //var command = `/usr/bin/node ${server} >> ${this.logdir}/${lp}-out.log 2>>${this.logdir}/${lp}-err.log &`;
    var command = `/usr/bin/node  /var/www/node-apps/gigsnet/${server}`;

    console.log("Starting " + confLine[ 1 ] + " in directory", cwd, "with gid and uid", gid, uid, "and with env:\nCommand:\n", command, "\nEnvironment:", env );
    
    try {
      var out = fs.createWriteStream(`${this.logdir}/${lp}-out.log`, { flags: 'a', defaultEncoding: 'utf8' } );
      var err = fs.createWriteStream(`${this.logdir}/${lp}-err.log`, { flags: 'a', defaultEncoding: 'utf8' } );
    } catch( e ){
      console.log("Could not open log files for writing:", e );
      return;
    }

    try {
      var child = childProcess.spawn( '/usr/bin/node', [ server ], { env: env, uid: uid, gid: gid, cwd: cwd } );
    } catch( e ) {
      console.log("Could not run node:", e );
      return;
    }

    child.stdout.on('data', function( data ){

      // The child process has stopped dealing with incoming connections.
      // For all intents and purposes, the process is useless and dead
      var d = data.toString();
      if( data.toString().match( /^THE SERVER HAS STOPPED$/m ) ){
        console.log("The child process has stopped taking connections!");
        try { fs.unlinkSync( pidFile ); } catch( e ){}
        dead = true;

        maybeRestart();    
      }
      out.write( data );
    });
    child.stderr.on('data', function( data ){
      err.write( data );
    });


    try { 
      fs.writeFileSync( pidFile, `${env.APPNAME}:${child.pid}` );
    } catch( e ) {
      console.log("Error creating pid file for process. This WILL cause problems", e );
    }


    var maybeRestart = function(){
      if( forever ){
        console.log(`Restarting ${appName} since it stopped working...`, confLine );
        self.start( confLine );
      }
    }

    // CLEANUP code
    var cleanUp = function(){
      try { 
        console.log("Cleaning up pid file for " + env.APPNAME );
        fs.unlinkSync( pidFile );
        child.kill('SIGTERM');
      } catch( e ) {
        console.log("Error cleaning up (but will keep on working):", e );
      }
      maybeRestart();
    }
    process.on( 'SIGTERM', function(){
      if( !dead ) cleanUp();
    });

    process.on('uncaughtException', function (err) {
      if( !dead ) cleanUp();
    });
 
    console.log("Success!");
  },

  stop: function( confLine ){

    var env = confLine[ 6 ];
    var appName = confLine[ 1 ];
    var pidFile = `${this.vardir}/${env.APPNAME}`;

    try { 
      running = fs.existsSync( pidFile );
    } catch( e ) {
      console.log("Error checking if process file exists:", e );
      if( exitOnFail) process.exit(9);
      return;
    }

    if( !running ){
      console.log(`${appName} is not running` );
      return;
    }


    console.log("Stopping  processes for ", confLine[ 1 ], " as gis/uid" + confLine[ 4 ]  );

    try { 
      var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
    } catch( e ) {
      console.log("Error reading the pid file for the process:", e );
      if( exitOnFail) process.exit(9);
      if( exitOnFail) process.exit(9);
      return;
    }

    try {
      process.kill( pidInfo[ 1 ], 'SIGTERM' );
    } catch( e ){
      console.log("Error sending SIGTERM signal:", e );
      if( exitOnFail) process.exit(9);
      return;
    }

    try { 
      fs.unlinkSync( pidFile );
    } catch( e ) {
      console.log("Error deleting the pid file for the pricess after kill:", e );
      if( exitOnFail) process.exit(9);
      return;
    }

    
    console.log(`${appName} successfully stopped!` );
 
  },


  list: function( uidGidString ){

    vardir = this.vardir;

    try {
      var appNames = fs.readdirSync( this.vardir );
    } catch( e  ){
      console.log("Could not read directory:", this.vardir );
      process.exit(9);
    }

    if( !appNames.length ){
      console.log("No app currently running" );
      process.exit( 0 );
    }

    console.log("");
    console.log("Currently running apps:");
    console.log("-----------------------");

    appNames.forEach( ( appName ) => {
      try { 
        var pidFile = `${vardir}/${appName}`;
        var pidInfo = fs.readFileSync( pidFile ).toString().split(':');
      } catch( e ) {
        console.log("Error reading the pid file for the process:", e );
        if( exitOnFail) process.exit(9);
      }

      confLine = this.startableHash[ appName ];
      console.log( pidInfo[ 1 ] + ' - ' + confLine[ 1 ] + ' (' + confLine[ 2 ] + ') [' + confLine[ 3 ]  + '] running as ' + confLine[ 4 ] );
    });


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
            subject: `[${appName}] Error log grew`,
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

  case 'started':
  case 's':
    generator.list();
  break;

  case 'startable':
  case 'l':
    console.log("");
    console.log("Available apps:");
    console.log("---------------");
    // Show list of startable server, showing command, port and 
    generator.confLines.forEach( (confLine) => {
      if( confLine[ 0 ] == 'RUN' ){
        console.log( confLine[ 1 ] + ' (' + confLine[ 2 ] + ') [' + confLine[ 3 ]  + '] running as ' + confLine[ 4 ] );
      }
    });
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

  case 'start':
  case 'stop':
   
    if( !p1 ){
      console.log( usage );
      process.exit( 5 );
    }

     if( p2 && ( p2 != 'forever' ) ){
      console.log( usage );
      process.exit(1);
    }

    if( p2 == 'forever' && action == 'stop' ){
      console.log("The [forever] option will only work for start and startall");
      process.exit(1);
    }


    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log("Startable server not found:", p1 );
      console.log( "Use the 'list startable' parameters for the list of startable apps" );
      process.exit( 5 );
    } else {
      if( action == 'start' ){
        generator.start( confLine, p2 == 'forever' );
      } else {
        generator.stop( confLine );
      }
    }

  break;

  case 'startall':
  case 'stopall':

    if( p1 && ( p1 != 'forever' ) ){
      console.log( usage );
      process.exit(1);
    }

    if( p1 == 'forever' && action == 'stopall' ){
      console.log("The [forever] option will only work for start and startall");
      process.exit(1);
    }


    var startStopAllFunc = function( quiet ){
      Object.keys( generator.startableHash ).forEach( (appName ) => {
        var confLine = generator.startableHash[ appName ];

        if( action == 'startall' ){
          generator.start( confLine, p1 == 'forever' );
        } else {
          generator.stop( confLine );
        }
      });    
    }

  break;

  case 'config':
  break;

  case 'deploy':

    var j = path.join;

    if( ! generator.startableHash[ p1 ] ){
      console.log("development-app needs to be a runnable entry:", p1 );
      process.exit( 9 );
    }

    if( ! generator.startableHash[ p2 ] ){
      console.log("production-app needs to be a runnable entry:", p2 );
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
      console.log("development-app needs to be a runnable entry:", p1 );
      process.exit( 11 );
    }

    if( ! fs.existsSync( productionPath )){
      console.log("production-app needs to be a runnable entry:", p2 );
      process.exit( 12 );
    }

    var s,d;

    console.log("Archiving away public files in development environment...");
    s = j( develPath, "/public/f");
    d = j( p, '_archived', "f." + p1 + '.' + now );
    execSync(`mv ${s} ${d}`);

    console.log("Moving public files from production to development...");
    s = j( productionPath, "/public/f");
    d = j( develPath, "/public/f");
    execSync(`mv ${s} ${d}`);

    console.log("Archiving away old production folder...");
    s = productionPath;
    d = j( p, '_archived', p2 + '.' + now );
    execSync(`mv ${s} ${d}`);

    console.log("Turning current development environment into production...");
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

    console.log("DEPLOY DONE!");
  break;

  case 'dbprod2dev':


    if( ! generator.startableHash[ p1 ] ){
      console.log("production-app needs to be a runnable entry:", p1 );
      process.exit( 10 );
    }

    if( ! generator.startableHash[ p2 ] ){
      console.log("development-app needs to be a runnable entry:", p2 );
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


    // Check that the entry is a runnable process
    var confLine = generator.startableHash[ p1 ];
    if( !confLine ) {
      console.log(`${p1} needs to be a runnable entry:`, p1 );
      process.exit( 9 );
    }

    var db = confLine[ 6 ].DBNAME;

    var args = ['-u', user, '-p', password, '--authenticationDatabase', 'admin', db ];
    console.log("Running: mongo " +  args.join(' ' ) );
    spawn('mongo', ['-u', user, '-p', password, '--authenticationDatabase', 'admin', db ], {stdio: 'inherit', shell: true});
  break;

  case 'logcheck':
    generator.logcheck();
  break;

  default:
    console.log( usage );
    process.exit( 3 );
  break;
}

