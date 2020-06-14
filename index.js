/* eslint-disable no-console */

require('dotenv').config();
global.Promise = require('bluebird');
const fs = require('fs');
const _ = require('lodash');
const mysql = require('mysql');
const rimraf = require('rimraf');

const { env } = process;

const OUTPUT = 'output/';
rimraf.sync(OUTPUT);
fs.mkdirSync(OUTPUT);

const connection = mysql.createConnection({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});

const query = (sql) => new Promise((resolve, reject) => {
  connection.query(sql, (error, results) => {
    if (error) reject(error);

    const records = _.map(results, (result) => (
      _(result)
        .mapKeys((value, columnName) => columnName.replace(/ /g, ''))
        .mapKeys((value, columnName) => _.lowerFirst(columnName))
        .value()
    ));

    resolve(records);
  });
});

const getAllItems = () => {
  if (!env.NT_EMAILS) {
    throw new Error('No emails provided');
  }

  const emails = env.NT_EMAILS.split(',');

  return Promise.props({
    dbUsers: query('select * from users')
      .filter(({ email }) => emails.includes(email))
      .map(({ email }) => ({ id: email })),
    dbTasks: query('select * from tasks')
      .filter(({ owner }) => emails.includes(owner))
      .map((task) => _.pick(task, [
        'id',
        'owner',
        'title',
        'notes',
        'parentId',
        'status',
        'rank',
      ])),
  });
};

const appendToData = (data, key, fn) => {
  data[key] = fn(data); // eslint-disable-line no-param-reassign
  return data;
};

const appendItems = _.partialRight(appendToData, 'items', ({ dbUsers, dbTasks }) => [...dbUsers, ...dbTasks]);
const appendItemsById = _.partialRight(appendToData, 'itemsById', ({ items }) => _.keyBy(items, 'id'));

const dataToFileTuples = (data) => _.toPairs(data);
const writeData = ([filename, data]) => {
  const filepath = `${OUTPUT}${filename}.json`;
  console.info(`Writing: ${filepath}`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
};

getAllItems()
  .then(appendItems)
  .then(appendItemsById)
  .then(dataToFileTuples)
  .tap(() => { console.log(); })
  .map(writeData)
  .catch(console.error)
  .finally(() => {
    connection.end();
  });
