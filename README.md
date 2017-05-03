# naps (node apps)

A "node apps" management utility.
It assumes:

* Nginx
* Mongo DB

## Installation

npm install -g naps

## Configuration

Copy the example config file in /etc

## What it does

Naps is used to:

* Generate a config file suitable for Nginx as a reverse proxy
* Allocate local ports for the defined apps
* Set a sane (overridable) environment for the app to run into
* Set which user the app will run under
* Run and stop defined apps 
* List all applications marked as startable
* Run and stop all defined apps
* Deploy a "development" environment, archiving the current "production" one away
* Ensure that all apps that are meant to be running actually are running, by
  checking if the port they are meant to listen to are actually taken
* Copy the database from production to development
* Restart Nginx
* Run `mongo` on the right database given an `appName`
* Check the error logs constantly, sending an email with the new contents
  to admins if they grow
* Restart automatically a server (in a debouncing fashion) if files are 
  modified, especially useful in development environments

## Usage

Naps is the holy grail of node app management when used with NginX as reverse proxy.

Your init script will typically contain:

    naps reset                                   # Clean up
    naps startall forever >> /var/log/naps.log & # Start all apps
    naps watchall         >> /var/log/naps.log & # Restart on change
    naps logcheck         >> /var/log/naps.log & # Email if error log grows

Usage:
    naps help
    This help screen

    CONFIG OPTIONS

    naps config or naps c
    Display all of the config entries

    naps config write
    Write the expanded nginx config onto the CONF file


    MONITORING OPTIONS

    naps reset
    Cleans out all lock files in /var/naps used to know what apps are running
    Typically run before 'naps startall forever' at boot time

    naps list or naps l
    List all apps, showing the ones that have started


    SINGLE APP MANAGEMENT OPTIONS
    (Output is always timestamped, log-like output)

    naps start <app-name> [forever]
    Start a specific app. NOTE: all console messages are timestamped and
    paired to the started process.
    If <forever> is passed, naps will monitor the app and make sure that
    it's restarted when needed.
    If the node server outputs one line with 'NAPS: DEAFENING', it's assumed
    that it no longer listens to its assigned port.
    Note that the node instance's logs are in $LOGDIR/$APPNAME-out.log
    and $LOGDIR/$APPNAME-err.log

    naps stop <app-name>
    Stop a specific app
   
    naps kill <app-name> [delay]
    Kill a specific app by sending a SIGKILL
    If <delay> is passed, naps will wait <delay> milliseconds before killing

    naps watch <appname>
    Will watch the app's directory, restart the app if anything changes


    BATCH APP MANAGEMENT OPTIONS
    (Will run naps itself as a background process; will run one different
    naps process per app) 

    naps startall [forever]
    Start all startable apps

    naps stopall
    Stop all startable apps

    naps killall [delay]
    kill all startable apps by sending a SIGKILL

    naps watchall
    Watch all startable apps marked as 'development'


    MONITORING OPTIONS

    naps logcheck
    Will check the error logs and inform the admin if more entries are added
    Error logs are assumed to be in $LOGDIR/$APPNAME-err.log


    SYSADMIN OPTIONS

    naps logs <app-name> [err]
    Will show node logs for that app. Will display stdout by default.
    If 'err' is added, it will display the node instance's stderr
 
    naps deploy <development-app> <production-app>
    Will overwrite development app onto production one, archiving production
    Files under public/f will be spared

    naps dbprod2dev <production-app> <development-app>
    Copy database from production app to development. DEVEL DB WILL BE ZAPPED.

    naps nginx-restart or naps nr
    Restart nginx

    naps dbadmin <app>
    Starts a mongo shell on <app>'s database, passing the admin's password


