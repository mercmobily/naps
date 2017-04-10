#!/usr/bin/env node

// https://github.com/foreverjs/forever/issues/918

var fs = require('/usr/lib/node_modules/fs-extra');
var execSync = require('child_process').execSync;
var spawn = require('child_process').spawn;
var path = require('path');

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
    List all apps currently running under forever (considering all possible uid/gid pairs)

    ${cmd} startall [continuous]
    Start all apps that can be started. 
    If [continuous] is specified, then it will try and restart every 10 seconds, and
    it will not generate any output

    ${cmd} stopall
    Stop all apps

    ${cmd} start <app-name>
    Start a specific app using forever

    ${cmd} stop <app-name>
    Start a specific app using forever
    
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
  this.emails = '';
  this.ip = '';
  this.dir = '/var/www/node-apps/';
  this.logdir = '/var/log/forever/';
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
    },

    LOGDIR: function( confLine, logdir ){
      this.logdir = logdir; 
      return '';
    },


    DIR: function( confLine, dir ){
      this.dir = dir; 
      return '';
    },

    EMAILS: function( confLine, emails ){
      this.emails = emails; 
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
        HOME: '/home/forever',
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

      this.errorLogs[ env.APPNAME ] = `/var/log/forever/${env.APPNAME}-err.log`

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

  start: function( confLine, quiet, exitOnFail ){

    var env = confLine[ 6 ];


    var r = '';

    // If nothing is found, grep will return 0
    try { 
      r = execSync(`netstat -tuplen | cut -b 21-44 | grep '127.0.0.1:${env.PORT}'` );
    } catch( e ) { }

    if( r.length ){
      if( !quiet ) console.log(`Cannot run process ${env.APPNAME} as the port is already taken`);
      return;
    }

    if( !quiet ) console.log("RUNNING:", confLine );

    // Work out gid and uid
    var uidGid = confLine[ 4 ].split( /:/ );
    var uid = Number( uidGid[ 0 ] );
    var gid = Number( uidGid[ 1 ] );
   
    // Work out cwd
    var cwd = path.join( this.dir, env.APPNAME );

    var extraForeverSwitch = "";
    if( env.NODE_ENV == 'development' ){
      var extraForeverSwitch ="--watch --watchDirectory " + cwd;
    }       

    var lp = env.APPNAME;
    var server = env.SERVER;
    var appName = env.APPNAME;
    var foreverCommand = `/usr/bin/forever start -m 1 --killSignal=SIGTERM --uid ${appName} -a ${extraForeverSwitch} -l /var/log/forever/${lp}-forever.log -o /var/log/forever/${lp}-out.log -e /var/log/forever/${lp}-err.log ${server}`;

    if( !quiet ) console.log("Starting " + confLine[ 1 ] + " in directory", cwd, "with gid and uid", gid, uid, "and with env:\nForever command:\n", foreverCommand, "\nEnvironment:", env );
    
    try {
      execSync( foreverCommand, { env: env, uid: uid, gid: gid, cwd: cwd } );
    } catch( e ){
      if( !quiet ) console.log("Could not execute command:", e );
      if( exitOnFail) process.exit(9);
    }
  },

  stop: function( confLine, quiet, exitOnFall ){
    console.log("Stopping forever processes for ", confLine[ 1 ], " as gis/uid" + confLine[ 4 ]  );

     var env = {
      HOME: '/home/forever',
    };

    var appName = confLine[ 1 ];

    // Work out gid and uid
    var uidGid = confLine[ 4 ].split( /:/ );
    var uid = Number( uidGid[ 0 ] );
    var gid = Number( uidGid[ 1 ] );
 
    // Work out command
    var foreverCommand = `forever stop ${appName}`;
    if( !quiet) console.log("COMMAND:", foreverCommand );

    try {
      execSync( foreverCommand, { uid: uid, gid: gid, env: env } );
    } catch( e ){
      if( !quiet ) console.log("Could not execute command:", e );
      if( exitOnFall ) process.exit(9);
    }
    if( !quiet) console.log("Stop executed on", appName );
  },


  listForever: function( uidGidString ){
    console.log("Forever processes startning under gis/uid", uidGidString );

     var env = {
      HOME: '/home/forever',
    };

    // Work out gid and uid
    var uidGid = uidGidString.split( /:/ );
    var uid = Number( uidGid[ 0 ] );
    var gid = Number( uidGid[ 1 ] );
 
    // Work out command
    var foreverCommand = `forever list`;

    try {
      var res = execSync( foreverCommand, { uid: uid, gid: gid, env: env } );
    } catch( e ){
      console.log("Could not execute command:", e );
      process.exit(9);
    }
    console.log( res.toString() );
    
  },


  logcheck: function(){

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
            console.log(`[${appName}] Emailing: `, contents.toString() );

            size = newSize;
            dealingWithChange = false;


          } catch( e ){
            console.log(`[${appName}] Couldn't read the log file:`, e );
          }


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
    for( var uidGid in generator.uidGidHash ){
      generator.listForever( uidGid );
    }
  break;

  case 'startable':
  case 'l':
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
 
    var confLine = generator.startableHash[ p1 ];
    if( !confLine ){
      console.log("Startable server not found:", p1 );
      console.log( "Use the 'list startable' parameters for the list of startable apps" );
      process.exit( 5 );
    } else {
      if( action == 'start' ){
        generator.start( confLine, false, true );
      } else {
        generator.stop( confLine, false, true );
      }
    }

  break;

  case 'startall':
  case 'stopall':

    if( p1 && ( p1 != 'continuous' ) ){
      console.log("Usage: configurer.js list [write]");
      process.exit(1);
    }

    var startStopAllFunc = function( quiet ){
      Object.keys( generator.startableHash ).forEach( (appName ) => {
        var confLine = generator.startableHash[ appName ];

        if( action == 'startall' ){
          generator.start( confLine, quiet, false );
        } else {
          generator.stop( confLine, false, false );
        }
      });    
    }

    if( p1 == 'continuous' ){
      setTimeout( function(){
        setInterval( function(){
          startStopAllFunc( true );
        }, 10000 );
      }, 60000 );
    } else {
      startStopAllFunc( false );
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

