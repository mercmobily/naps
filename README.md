# naps (node apps)

A "node apps" management utility.
It assumes:

* Nginx
* Mongo DB
* Forever

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
* Run and stop defined apps using `forever`
* List all applications marked as startable
* Run and stop all defined apps
* Deploy a "dvelopment" environment, archiving the current "production" one away
* Ensure that all apps that are meant to be running actually are running, by
  checking if the port they are meant to listen to are actually taken
* Copy the database from production to development
* Restart Nginx
* Run `mongo` on the right database given an `appName`
* Check the error logs constantly, sending an email with the new contents
  to admins if they grow


### Notes

The `forever` utility is used for process management more than
restart-management. Basicaly, `forever` is used with the parameter `-m 1`,
which effectively inhibits `forever`'s function of restarting a process.
`forever` is used however to `name` processes, and to group them under
different users. To make sure that processes stay up, `naps startall continuous`
will check that a port that is meant to be listened to actually is -- if not,
it will restart the process.

## Usage

    naps help
    This help screen

    naps config or naps c
    Display all of the config entries

    naps config write
    Write the expanded nginx config onto the CONF file

    naps startable or naps l
    List all apps that can be started

    naps started or naps s
    List all apps currently running under forever (considering all possible uid/gid pairs)

    naps startall [continuous]
    Start all apps that can be started. 
    If [continuous] is specified, then it will try and restart every 10 seconds, and
    it will not generate any output

    naps stopall
    Stop all apps

    naps start <app-name>
    Start a specific app using forever

    naps stop <app-name>
    Start a specific app using forever
    
    naps deploy <development-app> <production-app>
    Will overwrite development app onto production one, archiving the current production one.
    Files under public/f will be spared

    naps dbprod2dev <production-app> <development-app>
    Copy database from production app to development app. DEVEL DB WILL BE ZAPPED.

    naps nginx-restart or naps nr
    Restart nginx

    naps dbadmin <app>
    Starts a mongo shell on <app>'s database, passing the admin's password

    naps logcheck
    Will check the error logs and inform the admin if more entries are added

