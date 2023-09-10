# Building Serenade Quickstart

This is a quick guide to get your Serenade build as fast as possible. It covers
build process for the client and the server. The client can be built from Linux
or Windows (Ubuntu Focal or Jammy). The server can be built on Linux (Ubuntu
Focal or Jammy).

We strongly recommend you to run this from inside the VM or a container. The
first thing you need to do is to download the source code:

```shell
git clone https://github.com/serenadeai/serenade.git
```

## Linux Build

For both the client and the server, you must use the following script to
install the prerequisites:

```shell
cd serenade/
./scripts/setup/setup-ubuntu.sh
```

Once done, export the variables like indicated by the script.

### Building the client

```shell
cd serenade/
gradle :client:clientDistLinux
```

The output by of this command is an appImage that can be run on any Linux
system. You can find the appImage in `client/dist/Serenade-<version>.AppImage`.
This image must be used with one of the remote servers. To create an image that
has the local server, you must also be the server.


### Building the server

Run the build dependencies script. This script will install all the necessary
dependencies to build the server. It takes a while to complete:

```shell
cd serenade/
./scripts/setup/build-dependencies.sh
```

Once done, you can build the server:

```shell
cd serenade/
gradle installd
gradle client:fullDistLinux
```
