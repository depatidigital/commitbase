FROM openjdk:17-jdk-alpine

WORKDIR /app

# Copy JAR file
COPY *.jar app.jar

EXPOSE {{port}}

CMD ["java", "-jar", "app.jar"] 