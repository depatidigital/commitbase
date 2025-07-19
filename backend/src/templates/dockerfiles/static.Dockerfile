FROM nginx:alpine

# Copy static files
COPY . /usr/share/nginx/html

# Copy nginx configuration if it exists
{{#if nginxConfig}}
COPY nginx.conf /etc/nginx/nginx.conf
{{/if}}

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"] 