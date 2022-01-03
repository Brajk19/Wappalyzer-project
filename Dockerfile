FROM node:12-slim

RUN apt-get update \
    && apt-get install -y netcat \
    && apt-get install -y wget

COPY . /app
WORKDIR /app

RUN wget https://raw.githubusercontent.com/eficode/wait-for/master/wait-for
RUN chmod +x ./wait-for

RUN npm install
