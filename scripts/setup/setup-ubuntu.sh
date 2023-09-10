#!/bin/bash -e

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
. $HERE/paths.sh
cd $SERENADE_LIBRARY_ROOT

gpu=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --gpu)
      gpu=true
      ;;
    --cpu)
      gpu=false
      ;;
    --debug)
      set -x
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
  shift
done

ubuntu_codename=$(lsb_release -cs)

sudo-non-docker apt-get update
sudo-non-docker apt-get install --upgrade -y \
  apt-transport-https \
  curl \
  gnupg2 \
  wget \
  ca-certificates

if [[ "$gpu" == "true" ]] ; then
  sudo-non-docker apt-get install --upgrade -y ubuntu-drivers-common
  sudo-non-docker ubuntu-drivers autoinstall
fi

curl -sL https://apt.repos.intel.com/intel-gpg-keys/GPG-PUB-KEY-INTEL-SW-PRODUCTS.PUB | sudo-non-docker gpg --dearmor -o /etc/apt/trusted.gpg.d/intel-mkl.gpg
echo "deb https://apt.repos.intel.com/mkl all main" | sudo-non-docker tee /etc/apt/sources.list.d/intel-mkl.list

NODE_MAJOR=18
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo-non-docker gpg --dearmor -o /etc/apt/trusted.gpg.d/nodesource.gpg
echo "deb [arch=amd64] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo-non-docker tee /etc/apt/sources.list.d/nodesource.list
sudo-non-docker apt-get update
sudo-non-docker apt-get install nodejs -y

# '< /dev/null > /dev/null' is used to suppress the output of the command and avoid prompts
sudo-non-docker DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --upgrade \
  autoconf \
  automake \
  build-essential \
  ca-certificates \
  clang-format \
  cmake \
  ffmpeg \
  fonts-liberation \
  gawk \
  gconf-service \
  gdb \
  gfortran \
  git \
  groff \
  intel-mkl \
  libasound2 \
  libc++-dev \
  libssl-dev \
  libpq-dev \
  libtool \
  logrotate \
  lsb-release \
  $([[ "$gpu" == "true" ]] && echo "nvidia-cuda-toolkit")  \
  postgresql-client \
  psmisc \
  python2-minimal \
  python3 \
  python3-dev \
  python3-pip \
  redis-tools \
  rsync \
  sox \
  subversion \
  swig \
  unzip \
  vim \
  xdg-utils \
  yarn \
  zlib1g-dev \
  pkg-config \
  libx11-dev \
  uglifyjs \
  libxtst-dev \
  libfuse2 \
  libblas-dev \
  libblas3 \
  $([[ "$ubuntu_codename" != "focal" ]] && echo "libcublas11")  \
  libgsl-dev \
  libatlas-base-dev \
  intel-mkl-64bit-2020.0-088 \
  < /dev/null > /dev/null

curl https://download.java.net/java/GA/jdk14.0.1/664493ef4a6946b186ff29eb326336a2/7/GPL/openjdk-14.0.1_linux-x64_bin.tar.gz -Lso jdk.tar.gz
tar xf jdk.tar.gz
rm jdk.tar.gz

curl https://services.gradle.org/distributions/gradle-7.4.2-bin.zip -Lso gradle-7.4.2-bin.zip
unzip -qq gradle-7.4.2-bin.zip
rm gradle-7.4.2-bin.zip

sudo ln -s $SERENADE_LIBRARY_ROOT/gradle-7.4.2/bin/gradle /usr/local/bin/gradle
sudo ln -s jdk-14.0.1/bin/java /usr/local/bin/java

if [[ "${ubuntu_codename}" == "focal" ]] ; then
  python3 -m pip install pip --upgrade
  pip install pyopenssl --upgrade
fi

echo "" && echo "" && echo ""
echo "Install complete!"
echo "Now, run ./scripts/setup/build-dependencies.sh and add the following to your ~/.zshrc or ~/.bashrc:"
echo "export PATH=\"$SERENADE_LIBRARY_ROOT/jdk-14.0.1/bin:$SERENADE_LIBRARY_ROOT/gradle-7.4.2/bin:\$PATH\""
echo "export JAVA_HOME=\"$SERENADE_LIBRARY_ROOT/jdk-14.0.1\""

# If we're not installing on docker, we need to restart.
if [[ "$gpu" == "true" && "$EUID" != 0 ]] ; then
  echo ""
  echo "Restart your system to complete setup."
fi
