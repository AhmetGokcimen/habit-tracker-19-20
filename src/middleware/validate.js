'use strict';

// Step 3 of every request: "is the data safe to use?"
//
// validate({ body, query }) parses the request with zod schemas. Schemas are
// strict objects, so unknown fields (e.g. "role", "user_id") are rejected
// instead of silently passed through (mass assignment). Routes read only from
// req.valid.body / req.valid.query, never from raw req.body / req.query.

const { badRequest } = require('../utils/httpError');

function formatIssues(issues) {
  return issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}

function validate(schemas) {
  return (req, _res, next) => {
    req.valid = {};
    for (const part of ['body', 'query']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        return next(badRequest('Validation failed', formatIssues(result.error.issues)));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

module.exports = { validate };
