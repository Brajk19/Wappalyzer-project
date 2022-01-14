FROM node:alpine

RUN apk update  \
    && which crond \
    && rm -rf /etc/periodic

COPY . /app
WORKDIR /app

RUN wget https://raw.githubusercontent.com/eficode/wait-for/master/wait-for
RUN chmod +x ./wait-for

RUN npm install

COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["crond", "-f", "-l", "2"]

