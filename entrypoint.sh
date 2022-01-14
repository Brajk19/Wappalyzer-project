#!/bin/sh

env >> /etc/environment

# wait until container with elasticsearch is ready
./wait-for elasticsearch:9200 -t 999 -- echo "Elasticsearch is up"

# execute CMD
echo "$@"
exec "$@"