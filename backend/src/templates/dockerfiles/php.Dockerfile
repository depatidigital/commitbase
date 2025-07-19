FROM php:8.2-apache

WORKDIR /var/www/html

# Copy source code
COPY . .

# Set permissions
RUN chown -R www-data:www-data /var/www/html

EXPOSE 80

CMD ["apache2-foreground"] 