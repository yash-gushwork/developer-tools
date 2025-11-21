# S3 Upload Script with CloudFront Invalidation

A Node.js script to upload folder contents to an S3 bucket with appropriate cache control headers and optional CloudFront CDN invalidation.

## Quick Usage

```bash
node index.js <dist-path> <s3-path> <bucket-name> [region] [distribution-id] [invalidation-path] [monitor-progress]
```

### Example
```bash
node index.js /Users/yashsharma/Desktop/work/themes/dist website/mangalampipes-ys1ih/ gw-content-store us-east-1 E1DTLETE7MR3SY "/website/mangalampipes-ys1ih/*"
```
expandastands-fitmsf
## Features

- Recursively uploads all files from a folder to S3
- Sets Cache-Control headers:
  - HTML files: `public, max-age=0, must-revalidate`
  - Non-HTML files: `public, max-age=31536000, immutable`
- Preserves folder structure in S3
- Progress logging and error handling
- Automatic MIME type detection
- **NEW**: Optional CloudFront CDN invalidation after upload
- **NEW**: Real-time CloudFront invalidation progress monitoring
- Automatically deletes existing _astro and category folders from S3
- Uploads _astro folder with immutable cache control
- Uploads category folder with default cache control settings

## Installation

```bash
npm install
```

## Requirements

- Node.js 14+ (ES6 modules support)
- AWS IAM credentials with S3 and CloudFront permissions
- Valid AWS S3 bucket access
- Optional: CloudFront distribution for cache invalidation

## Usage

```bash
node index.js <dist-path> <s3-path> <bucket-name> [region] [distribution-id] [invalidation-path] [monitor-progress]
```

### Arguments

- `dist-path` - Local absolute path to dist folder containing **at least one** of:
  - `_astro/` folder (Astro framework assets)
  - `category/` folder (category-specific content)
- `s3-path` - S3 path where folders should be uploaded (e.g., "my-app/" or "production/")
- `bucket-name` - S3 bucket name
- `region` - AWS region (optional, defaults to us-east-1)
- `distribution-id` - CloudFront distribution ID (optional, for CDN invalidation)
- `invalidation-path` - Path pattern to invalidate in CloudFront (optional, e.g., "/website/app/*")
- `monitor-progress` - Whether to monitor invalidation progress (optional, defaults to true)

> **Note**: The script expects either `_astro` or `category` folders (or both) to exist in the dist directory. Upload will fail if neither folder is found.

### Examples

```bash
# Basic upload without CloudFront invalidation
node index.js /path/to/dist my-app/ my-bucket

# Upload with custom region
node index.js /path/to/dist production/ my-bucket us-west-2

# Upload with CloudFront invalidation
node index.js /path/to/dist website/app/ my-bucket us-east-1 E1DTLETE7MR3SY "/website/app/*"

# Multiple invalidation paths (comma-separated)
node index.js /path/to/dist website/app/ my-bucket us-east-1 E1DTLETE7MR3SY "/website/app/*,/website/assets/*"

# Upload with invalidation but without progress monitoring
node index.js /path/to/dist website/app/ my-bucket us-east-1 E1DTLETE7MR3SY "/website/app/*" false
```

## AWS Credentials

Set your AWS credentials using one of these methods:

### .env File (Recommended)
Create a `.env` file in the same directory as the script:
```bash
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
```

### Environment Variables
```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1
```

### AWS CLI
```bash
aws configure
```

## Cache Control Headers

- **HTML files** (`.html`, `.htm`): `public, max-age=0, must-revalidate`
- **All other files**: `public, max-age=31536000, immutable`

This ensures HTML files are always fresh while static assets can be cached for a year.

## CloudFront Invalidation

When you provide a distribution ID and invalidation path, the script will automatically create a CloudFront invalidation after successful uploads:

- Supports single path invalidation: `"/website/app/*"`
- Supports multiple paths (comma-separated): `"/website/app/*,/website/assets/*"`
- Shows invalidation ID and status
- **Real-time progress monitoring** (polls every 10 seconds)
- Continues execution even if invalidation fails (with warning)

### Progress Monitoring

By default, the script monitors CloudFront invalidation progress in real-time:

- **Active monitoring**: Polls the invalidation status every 10 seconds
- **Status updates**: Shows current status, creation time, and paths being invalidated
- **Automatic completion**: Stops polling when invalidation reaches "Completed" status
- **Timeout protection**: Stops monitoring after 5 minutes to prevent infinite polling
- **Manual monitoring**: To disable progress monitoring, pass `false` as the last parameter

#### Example Progress Output:
```
🔍 Monitoring invalidation progress: ET8XABCD123456789
📊 Status: InProgress | Created: 2024-01-15T10:30:00.000Z | Paths: /website/app/*, /website/assets/*
⏳ Invalidation in progress, checking again in 10s...
📊 Status: Completed | Created: 2024-01-15T10:30:00.000Z | Paths: /website/app/*, /website/assets/*
✅ Invalidation completed successfully!
```

## Output

The script provides detailed logging:
- ✅ Successful uploads with file details
- ❌ Failed uploads with error messages
- 📊 Summary with total counts and timing
- 🔄 CloudFront invalidation progress (when enabled)
- 🔍 Real-time invalidation monitoring (every 10 seconds)
- 🆔 Invalidation ID and status
- 🗑️ Deletion of existing objects before upload

## Troubleshooting

### Common Issues

**AWS Credentials Not Found**
```
❌ Error: AWS credentials not found!
```
- Ensure AWS credentials are set via `.env` file, environment variables, or AWS CLI
- Check that `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are properly configured

**Dist Folder Structure Error**
```
Error: Neither _astro nor category folder found in: /path/to/dist
```
- Verify that your dist folder contains at least one of: `_astro/` or `category/` folders
- Double-check the absolute path provided

**Upload Permissions**
- Ensure your AWS credentials have sufficient S3 permissions:
  - `s3:PutObject`
  - `s3:DeleteObject`
  - `s3:ListBucket`
  - `s3:GetObject`

**CloudFront Permission**
- For CDN invalidation, ensure your AWS credentials have CloudFront permissions:
  - `cloudfront:CreateInvalidation`

### Environment Setup

1. **Create `.env` file** (recommended):
   ```bash
   AWS_ACCESS_KEY_ID=your_key_here
   AWS_SECRET_ACCESS_KEY=your_secret_here
   AWS_REGION=us-east-1
   ```

2. **Or use AWS CLI**:
   ```bash
   aws configure
   ```

3. **Verify credentials**:
   ```bash
   aws sts get-caller-identity
   ```
