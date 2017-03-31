# naps (node apps)

This is a simple script that will create a very typical and repetitive conf file for nginx.

To see how it works:

* Copy it in the system's path
* Copy the conf file provided to /etc
* Run `naps` and see what it does.

In short, it will:

* Launch a node app using forever, after setting uid/gid and setting all the typical environment variables
* Allow you to define specific environment variables per app
* See the list of running apps. The difference between a straight "forever list" is that it will run forever
  as the right user/group for each used user/group
* Start an app or start all apps
* Stop an app, or stop all apps

Use, abuse it, change it. It made my devop life 1000000 times easier.
