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

const modifyData = (data, fn) => {
  fn(data); // eslint-disable-line no-param-reassign
  return data;
};

const appendDbTaskStatuses = _.partialRight(appendToData, 'dbTaskStatuses', ({ dbTasks }) => (
  _(dbTasks)
    .map('status')
    .uniq()
    .value()
));
const appendUsers = _.partialRight(appendToData, 'users', ({ dbUsers }) => dbUsers.map((user) => ({
  ...user,
  type: 'User',
})));
const appendTasks = _.partialRight(appendToData, 'tasks', ({ dbTasks }) => (
  dbTasks.map((task) => {
    const parentId = task.parentId === null ? task.owner : task.parentId;
    const isDivider = task.status === 'Divider';

    return (
      isDivider
        ? {
          ..._.pick(task, [
            'id',
            'owner',
            'rank',
          ]),
          type: 'Divider',
          parentId,
          isDivider,
        }
        : {
          ..._.pick(task, [
            'id',
            'owner',
            'title',
            'notes',
            'rank',
          ]),
          type: 'Todo',
          parentId,
          isChecked: task.status === 'Checked',
          isRoot: task.status === 'Root',
        }
    );
  })
));
const appendRootTasks = _.partialRight(appendToData, 'rootTasks', ({ tasks }) => _.filter(tasks, 'isRoot'));
const appendItems = _.partialRight(appendToData, 'items', ({ users, tasks }) => [...users, ...tasks]);
const appendItemsById = _.partialRight(appendToData, 'itemsById', ({ items }) => _.keyBy(items, 'id'));
const appendTasksByParentId = _.partialRight(appendToData, 'tasksByParentId', ({ tasks }) => (
  _(tasks)
    .groupBy('parentId')
    .mapValues((childTasks) => _.sortBy(childTasks, 'rank'))
    .value()
));
const replaceRootTasksWithUsers = _.partialRight(modifyData, ({ users, tasksByParentId }) => {
  users.forEach((user) => {
    const [rootTask] = tasksByParentId[user.id];
    const rootTaskChildren = tasksByParentId[rootTask.id];

    /* eslint-disable no-param-reassign */
    rootTaskChildren.forEach((task) => {
      task.parentId = user.id;
    });

    delete tasksByParentId[rootTask.id];
    tasksByParentId[user.id] = rootTaskChildren;
    /* eslint-enable no-param-reassign */
  });
});
const appendTasksToParent = (parent, tasksByParentId) => {
  parent.tasks = tasksByParentId[parent.id] || []; // eslint-disable-line no-param-reassign
  parent.tasks.forEach((task) => {
    if (task.isDivider) return;

    appendTasksToParent(task, tasksByParentId);
  });
};
const appendTrees = _.partialRight(appendToData, 'trees', ({ users, tasksByParentId }) => {
  users.forEach((user) => {
    appendTasksToParent(user, tasksByParentId);
  });

  return _.keyBy(users, 'id');
});
const toPrettyTree = (treeNode) => {
  const {
    id: originalId,
    type,
    title,
    notes,
    tasks,
    isChecked,
  } = treeNode;

  const prettyTasks = _(tasks).map(toPrettyTree).fromPairs().value();

  const idSuffix = type === 'Todo' ? ` [${isChecked ? 'x' : ' '}]` : '';
  const id = `${_.padStart(originalId, 6, '_')}${idSuffix}`;

  const titleAndNotes = notes ? `${title}|${notes}` : title;

  switch (type) {
    case 'Divider': return [id, '-------------------------'];
    case 'Todo': return (
      tasks.length === 0
        ? [id, titleAndNotes]
        : [`${id} : '${titleAndNotes}'`, prettyTasks]
    );
    case 'User': return [id, prettyTasks];
    default: throw new Error(`Unknown type ${type}`);
  }
};
const appendPrettyTrees = _.partialRight(
  appendToData,
  'prettyTrees',
  ({ trees }) => _(trees)
    .values()
    .map((user) => toPrettyTree(user))
    .fromPairs()
    .value(),
);

const dataToFileTuples = (data) => _.toPairs(data);
const writeData = ([filename, data]) => {
  const filepath = `${OUTPUT}${filename}.json`;
  console.log(`Writing: ${filepath}`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
};

getAllItems()
  .then(appendDbTaskStatuses)
  .then(appendUsers)
  .then(appendTasks)
  .then(appendRootTasks)
  .then(appendItems)
  .then(appendItemsById)
  .then(appendTasksByParentId)
  .then(replaceRootTasksWithUsers)
  .then(appendTrees)
  .then(appendPrettyTrees)
  .tap(() => { console.log(); })
  .then(dataToFileTuples)
  .map(writeData)
  .catch(console.error)
  .finally(() => {
    connection.end();
  });
